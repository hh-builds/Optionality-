/* =====================================================================
   Financial Optionality Engine
   Pure calculation layer — no UI, no DOM. Deterministic given inputs.
   Exposed as a global `Engine` object (also CommonJS export for tests).
   All money is nominal £ unless noted. Ages may be fractional.
   ===================================================================== */
(function (root) {
  'use strict';

  var clamp = function (x, lo, hi) { return Math.max(lo, Math.min(hi, x)); };
  var round2 = function (x) { return Math.round(x * 100) / 100; };

  // Savings plan = list of periods {fromYear, amount, allocPension}. Returns the
  // period active `t` years from now (the latest one that has started), or null.
  function normalisePlan(inp) {
    if (inp.savingsPlan && inp.savingsPlan.length) {
      return inp.savingsPlan.slice().sort(function (a, b) { return (a.fromYear || 0) - (b.fromYear || 0); });
    }
    // migrate legacy single-field setup
    return [{ fromYear: 0, amount: inp.annualSavings || 0,
              allocPension: (inp.allocPension != null ? inp.allocPension : 0.30) }];
  }
  function activeSavings(plan, t) {
    var best = null;
    for (var i = 0; i < plan.length; i++) {
      var fy = plan[i].fromYear || 0;
      if (fy <= t && (best === null || fy >= (best.fromYear || 0))) best = plan[i];
    }
    return best;
  }

  // ---- Default inputs -------------------------------------------------
  // Defaults use UK averages (2025/26) where available, best-estimate otherwise.
  // Sources noted in comments: ONS Wealth & Assets Survey, PLSA Retirement Living
  // Standards, full New State Pension 2025/26, HMRC allowances, BoE inflation target.
  var DEFAULTS = {
    // Personal
    currentAge: 35,
    targetOptionalityAge: 55,      // optional aspiration
    plannedStopAge: null,          // manual override of the optionality age (null = auto / earliest)
    pensionAccessAge: 57,          // UK minimum pension access age from April 2028
    lifeExpectancy: 90,            // prudent planning age (ONS cohort life expectancy ~87)
    statePensionAge: 68,           // legislated for those born after ~1978
    statePensionIncluded: true,
    statePensionAmount: 11973,     // full New State Pension 2025/26 (£230.25/wk)

    // Pension
    pensionCurrent: 35000,         // ONS avg pension wealth, age 35–44
    employerContribution: 4000,    // annual workplace contribution (auto-enrolment on ~median pay)
    pensionReturn: 0.07,           // long-run nominal equity/balanced return
    pensionFee: 0.005,             // typical all-in workplace fund charge
    withdrawalRate: 0.04,          // sustainable pension withdrawal rate
    pensionBuffer: 0.10,           // safety margin on top of the pension target (coast + status)

    // ISA
    isaCurrent: 25000,             // avg adult ISA holdings (HMRC/ONS)
    isaReturn: 0.07,

    // GIA
    giaCurrent: 5000,
    giaReturn: 0.07,
    giaTaxDrag: 0.005,

    // Cash
    cashCurrent: 10000,            // typical household savings balance

    // Bridge (post-stop, pre-pension-access)
    bridgeReturn: 0.05,

    // Inflation
    inflation: 0.025,              // long-run assumption (BoE target 2% + margin)

    // Spending
    bridgeSpending: 30000,         // annual, before pension access (~PLSA moderate, single)
    retirementSpending: 30000,     // annual, after pension access (~PLSA moderate, single)
    spendingInflationLinked: true,

    // Savings plan — list of periods, each active from `fromYear` (years from now)
    // until the next period starts. amount is annual; allocPension = share to pension.
    savingsPlan: [
      { fromYear: 0, amount: 6000, allocPension: 0.30 }   // ~median household annual saving
    ],
    // legacy mirrors of period 0 (kept for back-compat / migration)
    annualSavings: 6000,
    allocPension: 0.30,

    // Property (optional, informational)
    homeValue: 290000,             // ~UK average house price
    mortgage: 150000,

    // Future cash events — timed as "years from now" (yearsFromNow)
    cashEvents: [
      { name: 'Lump sum', amount: 10000, yearsFromNow: 5, direction: 'in', account: 'gia' }
    ]
  };

  // ---- Core single-path simulation ------------------------------------
  // Simulate the plan assuming the user stops work permanently at `stopAge`.
  // Returns rows + summary. Handles fractional stopAge via a transition year.
  function simulate(inp, stopAge) {
    var infl = inp.inflation;
    var startAge = inp.currentAge;
    var accessAge = inp.pensionAccessAge;
    var endAge = inp.lifeExpectancy;

    var plan = normalisePlan(inp);

    // balances
    var pension = inp.pensionCurrent;
    var isa = inp.isaCurrent;
    var gia = inp.giaCurrent;
    var cash = inp.cashCurrent;

    var rows = [];
    var survived = true;
    var failAge = null;
    var minAccessibleBridge = Infinity;

    // Withdrawal-rate guardrail: track the portfolio draw as a % of the pot in
    // the retirement phase (age >= pension access). The 4% assumption is a
    // sustainability heuristic; here we MEASURE the actual rate so the UI can
    // warn when the plan leans on a rate above it.
    var initialSWR = null;   // first full retirement-year rate
    var peakSWR = 0;         // worst retirement-year rate
    var peakSWRAge = null;

    var pensionAtAccess = null;
    var accessibleAtOptionality = null;
    var accessibleAtAccess = null;

    var firstRetiredAge = Math.floor(stopAge);

    for (var a = startAge; a < endAge; a++) {
      var workFrac = clamp(stopAge - a, 0, 1);   // fraction of THIS year still working
      var spendFrac = 1 - workFrac;               // fraction retired / drawing down
      var yearsFromNow = a - startAge;
      var inflFactor = inp.spendingInflationLinked ? Math.pow(1 + infl, yearsFromNow) : 1;

      var pensionStart = pension, isaStart = isa, giaStart = gia, cashStart = cash;
      var accessStart = isa + gia + cash;

      var notes = [];

      // 1) Cash events at this integer age (inflows or one-off outflows / "hits")
      var pensionIn = 0, pensionOut = 0, accessIn = 0, accessOut = 0;
      for (var e = 0; e < inp.cashEvents.length; e++) {
        var ev = inp.cashEvents[e];
        var evAge = (ev.yearsFromNow != null) ? (startAge + ev.yearsFromNow) : ev.age;
        if (Math.floor(evAge) === a) {
          var acct = ev.account || ev.destination || 'gia';
          var dir = ev.direction || 'in';
          var amt = Math.abs(ev.amount);
          if (dir === 'in') {
            if (acct === 'pension') { pension += amt; pensionIn += amt; }
            else if (acct === 'isa') { isa += amt; accessIn += amt; }
            else if (acct === 'gia') { gia += amt; accessIn += amt; }
            else { cash += amt; accessIn += amt; }
            notes.push(ev.name + ' +' + Math.round(amt));
          } else {
            // one-off outflow: take from the chosen account, cascading across
            // accessible accounts if the chosen one can't cover it.
            var need = amt;
            if (acct === 'pension') {
              var tp = Math.min(pension, need); pension -= tp; need -= tp; pensionOut += tp;
            } else {
              var order = [acct].concat(['cash', 'isa', 'gia'].filter(function (x) { return x !== acct; }));
              for (var oi = 0; oi < order.length; oi++) {
                var bal = order[oi] === 'cash' ? cash : order[oi] === 'isa' ? isa : gia;
                var take = Math.min(bal, need); need -= take;
                if (order[oi] === 'cash') cash -= take;
                else if (order[oi] === 'isa') isa -= take;
                else gia -= take;
              }
              accessOut += (amt - need);
            }
            notes.push(ev.name + ' −' + Math.round(amt - need));
          }
        }
      }

      // 2) Contributions from the active savings period (scaled by working fraction)
      if (workFrac > 0) {
        var seg = activeSavings(plan, yearsFromNow);
        var segAmt = seg ? seg.amount : 0;
        var segAlloc = seg ? (seg.allocPension != null ? seg.allocPension : 0.30) : 0;
        var pensionSave = segAmt * segAlloc;
        var isaGiaSave = segAmt * (1 - segAlloc);
        var pc = (pensionSave + inp.employerContribution) * workFrac;
        pension += pc; pensionIn += pc;
        var ig = isaGiaSave * workFrac;
        // fill ISA up to £20k/yr first, remainder to GIA
        var isaRoom = 20000 * workFrac;
        var toIsa = Math.min(ig, isaRoom);
        isa += toIsa; gia += (ig - toIsa);
        accessIn += ig;
      }

      // capture pension-at-access (value at start of access-age year, after any contribs that year)
      if (a === Math.floor(accessAge) && pensionAtAccess === null) {
        pensionAtAccess = pension;
        accessibleAtAccess = isa + gia + cash;
      }
      if (a === firstRetiredAge && accessibleAtOptionality === null) {
        accessibleAtOptionality = isa + gia + cash;
      }

      // 3) Spending / withdrawals (only for the retired fraction of the year)
      var sppAmt = 0; // state pension received this year (informational)
      var withdrawalRate = 0;
      if (spendFrac > 0) {
        var baseSpend = (a < accessAge ? inp.bridgeSpending : inp.retirementSpending);
        var spendNeed = baseSpend * inflFactor * spendFrac;
        var sp = (inp.statePensionIncluded && a >= inp.statePensionAge)
          ? inp.statePensionAmount * inflFactor * spendFrac : 0;
        sppAmt = sp;
        var need = Math.max(0, spendNeed - sp);
        var potPreDraw = pension + isa + gia + cash;   // invested pot before this year's draw
        withdrawalRate = potPreDraw > 0 ? need / potPreDraw : 0;

        if (a < accessAge) {
          // BRIDGE: accessible only (cash -> isa -> gia)
          var draw = need;
          var fromCash = Math.min(cash, draw); cash -= fromCash; draw -= fromCash;
          var fromIsa = Math.min(isa, draw); isa -= fromIsa; draw -= fromIsa;
          var fromGia = Math.min(gia, draw); gia -= fromGia; draw -= fromGia;
          accessOut += (need - draw);
          if (draw > 0.5) { survived = false; if (failAge === null) failAge = a; }
        } else {
          // RETIREMENT: draw PROPORTIONALLY across every pot (pension + ISA + GIA
          // + cash) so no single account is drained while another compounds
          // untouched. Each pot then bears roughly the same withdrawal rate as
          // the portfolio overall. Any shortfall (a pot emptying) cascades to
          // whatever's left.
          var pPen = pension, pCash = cash, pIsa = isa, pGia = gia;
          var totPot = pPen + pCash + pIsa + pGia;
          var takePen = 0, takeCash = 0, takeIsa = 0, takeGia = 0, unmet = need;
          if (totPot > 0) {
            takePen = Math.min(pPen, need * pPen / totPot);
            takeCash = Math.min(pCash, need * pCash / totPot);
            takeIsa = Math.min(pIsa, need * pIsa / totPot);
            takeGia = Math.min(pGia, need * pGia / totPot);
            unmet = need - (takePen + takeCash + takeIsa + takeGia);
            // second pass: cover rounding / emptied-pot shortfall from the rest
            if (unmet > 0.005) {
              var rem2 = unmet;
              var t;
              t = Math.min(pCash - takeCash, rem2); takeCash += t; rem2 -= t;
              t = Math.min(pIsa - takeIsa, rem2); takeIsa += t; rem2 -= t;
              t = Math.min(pGia - takeGia, rem2); takeGia += t; rem2 -= t;
              t = Math.min(pPen - takePen, rem2); takePen += t; rem2 -= t;
              unmet = rem2;
            }
          }
          pension -= takePen; cash -= takeCash; isa -= takeIsa; gia -= takeGia;
          pensionOut += takePen;
          accessOut += (takeCash + takeIsa + takeGia);
          if (unmet > 0.5) { survived = false; if (failAge === null) failAge = a; }
        }
      }

      // guardrail: record retirement-phase withdrawal rates (after access age)
      if (spendFrac >= 1 && a >= accessAge && withdrawalRate > 0) {
        if (initialSWR === null) initialSWR = withdrawalRate;
        if (withdrawalRate > peakSWR) { peakSWR = withdrawalRate; peakSWRAge = a; }
      }

      // track bridge low-water mark
      if (a >= stopAge && a < accessAge) {
        minAccessibleBridge = Math.min(minAccessibleBridge, isa + gia + cash);
      }

      // 4) Growth on remaining balances
      var inBridge = (a >= stopAge && a < accessAge);
      var pensionGrowthRate = inp.pensionReturn - inp.pensionFee;
      var isaRate = inBridge ? inp.bridgeReturn : inp.isaReturn;
      var giaRate = (inBridge ? inp.bridgeReturn : inp.giaReturn) - inp.giaTaxDrag;

      var pensionGrowth = pension * pensionGrowthRate;
      var isaGrowth = isa * isaRate;
      var giaGrowth = gia * giaRate;
      pension += pensionGrowth;
      isa += isaGrowth;
      gia += giaGrowth;

      var phase = (a < stopAge) ? 'accumulation' : (a < accessAge ? 'bridge' : 'retirement');

      rows.push({
        age: a,
        phase: phase,
        pensionStart: round2(pensionStart),
        pensionIn: round2(pensionIn),
        pensionOut: round2(pensionOut),
        pensionGrowth: round2(pensionGrowth),
        pensionEnd: round2(pension),
        accessStart: round2(accessStart),
        contributions: round2(accessIn),
        accessIn: round2(accessIn),
        accessOut: round2(accessOut),
        withdrawals: round2(accessOut),        // ISA/GIA/cash out (kept for back-compat)
        pensionWithdraw: round2(pensionOut),
        totalWithdraw: round2(pensionOut + accessOut),
        statePension: round2(sppAmt),
        withdrawalRate: withdrawalRate,
        growth: round2(isaGrowth + giaGrowth),
        accessEnd: round2(isa + gia + cash),
        isa: round2(isa), gia: round2(gia), cash: round2(cash),
        netWorth: round2(pension + isa + gia + cash),
        notes: notes.join('; ')
      });
    }

    if (minAccessibleBridge === Infinity) minAccessibleBridge = isa + gia + cash;
    var endWorth = pension + isa + gia + cash;

    return {
      survived: survived,
      failAge: failAge,
      rows: rows,
      endWorth: endWorth,
      minAccessibleBridge: minAccessibleBridge,
      pensionAtAccess: pensionAtAccess === null ? pension : pensionAtAccess,
      accessibleAtOptionality: accessibleAtOptionality === null ? (isa + gia + cash) : accessibleAtOptionality,
      accessibleAtAccess: accessibleAtAccess === null ? 0 : accessibleAtAccess,
      initialSWR: initialSWR,
      peakSWR: peakSWR,
      peakSWRAge: peakSWRAge
    };
  }

  // ---- Solve for the Financial Optionality Age ------------------------
  // Earliest stopAge (0.1yr precision) at which the plan survives to life expectancy.
  function findOptionalityAge(inp) {
    var lo = inp.currentAge;
    var hi = inp.lifeExpectancy;
    // if stopping now already works, optionality is now
    if (simulate(inp, lo).survived) return lo;
    // if even working to the end fails, unreachable
    if (!simulate(inp, hi).survived) return null;
    // binary search on the monotonic survive() boundary
    for (var i = 0; i < 40; i++) {
      var mid = (lo + hi) / 2;
      if (simulate(inp, mid).survived) hi = mid; else lo = mid;
      if (hi - lo < 0.02) break;
    }
    // `hi` is on the survivable side. Round UP to the 0.1 grid so the reported
    // age is guaranteed to survive (rounding down could land just below the
    // boundary and show a spurious shortfall). Nudge up if any edge case fails.
    var ans = Math.ceil(hi * 10) / 10;
    var guard = 0;
    while (ans < inp.lifeExpectancy && !simulate(inp, ans).survived && guard < 30) {
      ans = Math.round((ans + 0.1) * 10) / 10; guard++;
    }
    return ans;
  }

  // ---- Sustainable-rate guardrail ------------------------------------
  // The earliest stop age at which the plan not only survives to life
  // expectancy but does so with a first-year (retirement) withdrawal rate at
  // or below the assumed sustainable rate — i.e. it keeps a margin for a bad
  // run of markets rather than relying on central returns holding exactly.
  function sustainableOptionalityAge(inp) {
    var target = (inp.withdrawalRate || 0.04) * 1.05; // small tolerance band
    function ok(stop) {
      var s = simulate(inp, stop);
      if (!s.survived) return false;
      // if the plan never actually draws in retirement (e.g. covered by state
      // pension), treat it as within-rate.
      if (s.initialSWR == null) return true;
      return s.initialSWR <= target;
    }
    var lo = inp.currentAge, hi = inp.lifeExpectancy;
    if (ok(lo)) return lo;
    if (!ok(hi)) return null;                 // even working to the end can't get within-rate
    for (var i = 0; i < 40; i++) {
      var mid = (lo + hi) / 2;
      if (ok(mid)) hi = mid; else lo = mid;
      if (hi - lo < 0.05) break;
    }
    var ans = Math.ceil(hi * 10) / 10;
    var guard = 0;
    while (ans < inp.lifeExpectancy && !ok(ans) && guard < 30) { ans = Math.round((ans + 0.1) * 10) / 10; guard++; }
    return ans;
  }

  // Present value of a required-pension pot to fund retirement net spending
  // from access age to life expectancy (discounted at the pension growth rate).
  function requiredPensionAtAccess(inp) {
    var r = inp.pensionReturn - inp.pensionFee;
    var infl = inp.inflation;
    var total = 0;
    for (var a = inp.pensionAccessAge; a < inp.lifeExpectancy; a++) {
      var yearsFromNow = a - inp.currentAge;
      var inflF = inp.spendingInflationLinked ? Math.pow(1 + infl, yearsFromNow) : 1;
      var spend = inp.retirementSpending * inflF;
      var sp = (inp.statePensionIncluded && a >= inp.statePensionAge)
        ? inp.statePensionAmount * inflF : 0;
      var net = Math.max(0, spend - sp);
      var yearsToAccess = a - inp.pensionAccessAge;
      total += net / Math.pow(1 + r, yearsToAccess);
    }
    return total;
  }

  // Required accessible pot at optionality age to fund the bridge to pension access.
  function requiredBridgeValue(inp, optionalityAge) {
    var r = inp.bridgeReturn;
    var infl = inp.inflation;
    var total = 0;
    var start = Math.max(inp.currentAge, Math.floor(optionalityAge));
    for (var a = start; a < inp.pensionAccessAge; a++) {
      var yearsFromNow = a - inp.currentAge;
      var inflF = inp.spendingInflationLinked ? Math.pow(1 + infl, yearsFromNow) : 1;
      var spend = inp.bridgeSpending * inflF;
      var sp = (inp.statePensionIncluded && a >= inp.statePensionAge)
        ? inp.statePensionAmount * inflF : 0;
      var net = Math.max(0, spend - sp);
      var yearsToStart = a - start;
      total += net / Math.pow(1 + r, yearsToStart);
    }
    return total;
  }

  // Coast FIRE: earliest age at which the CURRENT pension (no further contributions)
  // grows on its own to the required pension at access.
  function coastFireAge(inp) {
    var r = inp.pensionReturn - inp.pensionFee;
    var req = requiredPensionAtAccess(inp) * (1 + (inp.pensionBuffer || 0));
    for (var a = inp.currentAge; a <= inp.pensionAccessAge; a += 0.1) {
      var grown = inp.pensionCurrent * Math.pow(1 + r, inp.pensionAccessAge - a);
      if (grown >= req) return Math.round(a * 10) / 10;
    }
    return null; // never coasts on current pot alone within timeframe
  }

  // The largest flat (today's-money) retirement spend the plan can actually
  // sustain to life expectancy, holding the stop age, savings and bridge fixed.
  // This is consistent with the survival simulation (unlike a flat 4% rule).
  function maxSustainableRetirement(inp, stopAge) {
    function survivesAt(R) {
      var x = JSON.parse(JSON.stringify(inp));
      x.retirementSpending = R;
      return simulate(x, stopAge).survived;
    }
    if (!survivesAt(0)) return 0;
    var lo = 0, hi = Math.max(inp.retirementSpending * 3, 250000), guard = 0;
    while (survivesAt(hi) && guard < 40) { hi *= 1.5; guard++; }
    for (var i = 0; i < 34; i++) {
      var mid = (lo + hi) / 2;
      if (survivesAt(mid)) lo = mid; else hi = mid;
    }
    return lo;
  }

  // Rough income breakdown (today's money) for display only.
  function sustainableRetirementIncome(inp, sim) {
    // pension pot at access supports withdrawalRate; plus state pension; plus
    // annuitised accessible remainder over the retirement horizon.
    var years = inp.lifeExpectancy - inp.pensionAccessAge;
    var accessRemainder = sim.accessibleAtAccess || 0;
    var accessAnnual = years > 0 ? accessRemainder / years : 0;
    var pensionAnnual = sim.pensionAtAccess * inp.withdrawalRate;
    var sp = inp.statePensionIncluded ? inp.statePensionAmount : 0;
    // discount nominal-at-access figures back to today's money
    var inflF = inp.spendingInflationLinked
      ? Math.pow(1 + inp.inflation, inp.pensionAccessAge - inp.currentAge) : 1;
    return {
      total: (pensionAnnual + accessAnnual) / inflF + sp,
      pensionIncome: pensionAnnual / inflF,
      accessIncome: accessAnnual / inflF,
      statePension: sp
    };
  }

  // ---- Full compute: everything the dashboard needs -------------------
  function compute(inp) {
    // earliest achievable optionality age (the "optimised" answer)
    var optionalityAge = findOptionalityAge(inp);
    // manual override: if the user has pinned a stop age, project to THAT instead
    var overridden = (inp.plannedStopAge != null && inp.plannedStopAge !== '' && !isNaN(inp.plannedStopAge));
    var planned = overridden ? inp.plannedStopAge : optionalityAge;
    var effectiveStop = (planned == null) ? inp.lifeExpectancy : planned;
    var sim = simulate(inp, effectiveStop);
    var planSurvives = sim.survived;

    var reqPensionRaw = requiredPensionAtAccess(inp);          // pot to just hit the target
    var reqPension = reqPensionRaw * (1 + (inp.pensionBuffer || 0)); // target + safety margin
    var reqBridge = requiredBridgeValue(inp, effectiveStop);
    var retInc = sustainableRetirementIncome(inp, sim);
    // consistent with the actual simulation: the real max retirement spend
    var maxRet = maxSustainableRetirement(inp, effectiveStop);

    var pensionDiff = sim.pensionAtAccess - reqPension;
    // Bridge adequacy from the ACTUAL simulation (not the PV estimate): if the
    // plan survives, the bridge held — the true surplus is what's left in
    // accessible accounts when the pension unlocks. Only when the bridge itself
    // fails do we fall back to the PV shortfall estimate.
    var bridgeHolds = planSurvives;
    var bridgeConsumed = Math.max(0, sim.accessibleAtOptionality - sim.accessibleAtAccess);
    var accessDiff = bridgeHolds ? sim.accessibleAtAccess : (sim.accessibleAtOptionality - reqBridge);
    var bridgeNeed = bridgeHolds ? bridgeConsumed : reqBridge;

    // status helpers
    function status(diff, base) {
      var ratio = base > 0 ? diff / base : (diff >= 0 ? 1 : -1);
      if (ratio >= 0.05) return 'ahead';
      if (ratio >= -0.05) return 'ontrack';
      return 'behind';
    }

    // confidence based on whether the (possibly overridden) plan survives and its buffer
    var buffer = sim.endWorth;
    var confidence;
    if (!planSurvives) confidence = 'low';
    else if (buffer > inp.retirementSpending * 3) confidence = 'high';
    else if (buffer > 0) confidence = 'medium';
    else confidence = 'low';
    // Guardrail: a plan leaning on a withdrawal rate above the sustainable guide
    // has little margin for a bad run of markets — cap its resilience rating so a
    // high starting draw can never read as "Strong".
    var wdTarget = inp.withdrawalRate || 0.04;
    if (planSurvives && sim.initialSWR != null) {
      if (sim.initialSWR > wdTarget * 1.5 && confidence === 'high') confidence = 'medium';
      if (sim.initialSWR > wdTarget * 1.5) confidence = (confidence === 'high') ? 'medium' : 'low';
      else if (sim.initialSWR > wdTarget * 1.1 && confidence === 'high') confidence = 'medium';
    }

    var yearsEarlyLate = (inp.targetOptionalityAge != null)
      ? round2(inp.targetOptionalityAge - effectiveStop) : null; // +ve = early

    // classify any shortfall: a "bridge" shortfall means accessible wealth runs
    // dry before pension access (wealth may be fine overall, just locked away);
    // a "retirement" shortfall means the money genuinely runs out.
    var failPhase = null;
    if (!planSurvives && sim.failAge != null) {
      failPhase = (sim.failAge < inp.pensionAccessAge) ? 'bridge' : 'retirement';
    }
    var bridgeShortfall = Math.max(0, reqBridge - sim.accessibleAtOptionality);

    return {
      inputs: inp,
      optionalityAge: optionalityAge,   // earliest achievable (the "optimised" age)
      effectiveStop: round2(effectiveStop),
      overridden: overridden,
      planSurvives: planSurvives,
      failAge: sim.failAge != null ? round2(sim.failAge) : null,
      failPhase: failPhase,
      bridgeShortfall: bridgeShortfall,
      achievable: optionalityAge !== null,
      confidence: confidence,
      yearsEarlyLate: yearsEarlyLate,
      rows: sim.rows,
      endWorth: sim.endWorth,

      pension: {
        current: inp.pensionCurrent,
        atAccess: sim.pensionAtAccess,
        required: reqPension,            // target + safety margin
        rawRequired: reqPensionRaw,      // pot to just hit the target
        buffer: inp.pensionBuffer || 0,
        netReturn: inp.pensionReturn - inp.pensionFee,
        yearsToAccess: inp.pensionAccessAge - inp.currentAge,
        difference: pensionDiff,
        status: status(pensionDiff, reqPension),
        coastFireAge: coastFireAge(inp)
      },
      accessible: {
        current: inp.isaCurrent + inp.giaCurrent + inp.cashCurrent,
        atOptionality: sim.accessibleAtOptionality,
        requiredBridge: bridgeNeed,
        difference: accessDiff,
        remainingAtAccess: sim.accessibleAtAccess,
        status: !bridgeHolds ? 'behind' : (accessDiff > inp.bridgeSpending ? 'ahead' : 'ontrack')
      },
      retirement: {
        sustainableIncome: maxRet,
        target: inp.retirementSpending,
        pensionIncome: retInc.pensionIncome,
        accessIncome: retInc.accessIncome,
        statePension: retInc.statePension,
        legacy: sim.endWorth,
        status: status(maxRet - inp.retirementSpending, inp.retirementSpending)
      },
      withdrawal: (function () {
        var target = inp.withdrawalRate || 0.04;
        // The classic "safe withdrawal rate" concept measures the FIRST year's
        // draw as a share of the pot; later years naturally rise toward 100% as
        // the pot is deliberately run down, so the peak is not a fair gauge.
        var initial = sim.initialSWR;
        var st = 'safe';
        if (initial != null) {
          if (initial > target * 1.5) st = 'high';
          else if (initial > target * 1.1) st = 'watch';
        }
        return {
          target: target,
          initialRate: initial,          // first full retirement year (the SWR)
          peakRate: sim.peakSWR || 0,    // late-life peak (approaches 100% by design)
          peakAge: sim.peakSWRAge,
          status: st,
          // earliest age that stays within the sustainable rate (the guardrailed answer)
          sustainableAge: sustainableOptionalityAge(inp),
          // A plan can still survive above 4% because the horizon is finite, the
          // State Pension arrives later, and central returns are assumed to hold —
          // but it has less margin for a bad run of markets. Flag that context.
          survivesAbove: (initial != null && initial > target * 1.1 && planSurvives)
        };
      })(),
      netWorth: {
        pension: inp.pensionCurrent,
        isa: inp.isaCurrent,
        gia: inp.giaCurrent,
        cash: inp.cashCurrent,
        homeEquity: Math.max(0, inp.homeValue - inp.mortgage),
        total: inp.pensionCurrent + inp.isaCurrent + inp.giaCurrent + inp.cashCurrent
      }
    };
  }

  function withPatch(inp, patch) { var x = JSON.parse(JSON.stringify(inp)); for (var k in patch) x[k] = patch[k]; return x; }
  function bumpSavings(inp, delta) {
    return normalisePlan(inp).map(function (s) { return { fromYear: s.fromYear || 0, amount: (s.amount || 0) + delta, allocPension: s.allocPension }; });
  }
  function shiftEvents(inp, yrs) {
    return (inp.cashEvents || []).map(function (e) { var c = JSON.parse(JSON.stringify(e)); if (c.yearsFromNow != null) c.yearsFromNow += yrs; else if (c.age != null) c.age += yrs; return c; });
  }

  // ---- Opportunity engine --------------------------------------------
  // Each lever carries a `patch` (absolute input changes) so the UI can apply it.
  function opportunities(inp) {
    var base = findOptionalityAge(inp);
    if (base === null) return [];
    var levers = [
      { label: 'Reduce annual spending by £10,000', patch: { bridgeSpending: inp.bridgeSpending - 10000, retirementSpending: inp.retirementSpending - 10000 } },
      { label: 'Save £5,000 more per year', patch: { savingsPlan: bumpSavings(inp, 5000) } },
      { label: 'Bring pension access forward to ' + (inp.pensionAccessAge - 2), patch: { pensionAccessAge: Math.max(inp.currentAge + 1, inp.pensionAccessAge - 2) } },
      { label: 'Receive a £100k lump sum in 1 year', patch: { cashEvents: (inp.cashEvents || []).concat([{ name: 'Extra liquidity', amount: 100000, yearsFromNow: 1, direction: 'in', account: 'gia' }]) } },
      { label: 'Increase returns by 1% p.a.', patch: { pensionReturn: inp.pensionReturn + 0.01, isaReturn: inp.isaReturn + 0.01, giaReturn: inp.giaReturn + 0.01, bridgeReturn: inp.bridgeReturn + 0.01 } }
    ];
    var out = [];
    for (var i = 0; i < levers.length; i++) {
      var na = findOptionalityAge(withPatch(inp, levers[i].patch));
      if (na === null) continue;
      out.push({ label: levers[i].label, deltaMonths: Math.round((base - na) * 12), patch: levers[i].patch });
    }
    out.sort(function (a, b) { return b.deltaMonths - a.deltaMonths; });
    return out;
  }

  // ---- Risk engine ----------------------------------------------------
  function risks(inp) {
    var base = findOptionalityAge(inp);
    if (base === null) return [];
    var shocks = [
      { label: 'Pension access rises to ' + (inp.pensionAccessAge + 2), patch: { pensionAccessAge: inp.pensionAccessAge + 2 } },
      { label: 'Returns average 2% lower', patch: { pensionReturn: inp.pensionReturn - 0.02, isaReturn: inp.isaReturn - 0.02, giaReturn: inp.giaReturn - 0.02, bridgeReturn: inp.bridgeReturn - 0.02 } },
      { label: 'Spending rises by £15,000/yr', patch: { bridgeSpending: inp.bridgeSpending + 15000, retirementSpending: inp.retirementSpending + 15000 } },
      { label: 'Inflation 2% higher', patch: { inflation: inp.inflation + 0.02 } },
      { label: 'Lump sums delayed by 3 years', patch: { cashEvents: shiftEvents(inp, 3) } }
    ];
    var out = [];
    for (var i = 0; i < shocks.length; i++) {
      var na = findOptionalityAge(withPatch(inp, shocks[i].patch));
      var deltaMonths = na === null ? 999 : Math.round((na - base) * 12);
      out.push({ label: shocks[i].label, deltaMonths: deltaMonths, breaks: na === null, patch: shocks[i].patch });
    }
    out.sort(function (a, b) { return b.deltaMonths - a.deltaMonths; });
    return out;
  }

  // ---- Savings-plan optimiser ----------------------------------------
  // Keeps the yearly savings AMOUNTS fixed (what you can actually save) and
  // searches the pension / ISA-GIA split — year by year — to make the earliest
  // optionality age as early as possible (tie-broken by the biggest end buffer,
  // for a more resilient plan). Returns a new savingsPlan.
  function optimisePlan(inp) {
    var startAge = inp.currentAge;
    var basePlan = normalisePlan(inp);
    var baseAge = findOptionalityAge(inp);
    var anySavings = basePlan.some(function (s) { return (s.amount || 0) > 0; });
    if (!anySavings) return { savingsPlan: JSON.parse(JSON.stringify(basePlan)), optionalityAge: baseAge, baselineAge: baseAge, changed: false };

    // horizon: the years you might still be saving (until you stop), + buffer
    var horizon = (baseAge == null)
      ? Math.min(Math.max(1, Math.round(inp.pensionAccessAge - startAge)), 40)
      : Math.min(Math.ceil(baseAge - startAge) + 2, 45);
    horizon = Math.max(1, horizon);

    var years = [];
    for (var t = 0; t < horizon; t++) {
      var seg = activeSavings(basePlan, t);
      years.push({ fromYear: t, amount: seg ? seg.amount : 0, allocPension: 0.30 });
    }

    var work = JSON.parse(JSON.stringify(inp));
    work.plannedStopAge = null;          // always optimise the EARLIEST achievable age
    function evalYears(ys) {
      work.savingsPlan = ys;
      var age = findOptionalityAge(work);
      if (age == null) return { age: 1e6, legacy: -1e18 };
      var sim = simulate(work, age);
      return { age: age, legacy: sim.endWorth };
    }
    // minimise age; among equal ages prefer a bigger safety buffer
    function scoreOf(r) { return r.age - r.legacy * 1e-12; }

    // 1) seed with the best single constant split
    var bestConst = 0.30, bestScore = null;
    for (var s = 0; s <= 100; s += 5) {
      var yc = years.map(function (y) { return { fromYear: y.fromYear, amount: y.amount, allocPension: s / 100 }; });
      var sc = scoreOf(evalYears(yc));
      if (bestScore === null || sc < bestScore) { bestScore = sc; bestConst = s / 100; }
    }
    for (var z = 0; z < years.length; z++) years[z].allocPension = bestConst;

    // 2) coordinate descent: refine each year's split, a couple of passes
    var steps = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
    for (var pass = 0; pass < 2; pass++) {
      for (var i = 0; i < years.length; i++) {
        var keep = years[i].allocPension;
        var kScore = scoreOf(evalYears(years));
        for (var k = 0; k < steps.length; k++) {
          years[i].allocPension = steps[k];
          var sc2 = scoreOf(evalYears(years));
          if (sc2 < kScore - 1e-9) { kScore = sc2; keep = steps[k]; }
        }
        years[i].allocPension = keep;
      }
    }

    // 2b) smoothing: carry the previous year's split forward whenever doing so
    // doesn't push the optionality age later — turns equivalent-but-jagged
    // allocations into clean, contiguous periods.
    for (var m = 1; m < years.length; m++) {
      var curAge = evalYears(years).age;
      var savedAlloc = years[m].allocPension;
      years[m].allocPension = years[m - 1].allocPension;
      if (evalYears(years).age > curAge + 1e-9) years[m].allocPension = savedAlloc;
    }

    // 3) collapse identical consecutive years into periods; drop years past the stop
    work.savingsPlan = years;
    var achieved = findOptionalityAge(work);
    var lastRelevant = (achieved == null) ? years.length : Math.min(years.length - 1, Math.ceil(achieved - startAge));
    var plan = [];
    for (var j = 0; j < years.length; j++) {
      if (j > lastRelevant) break;
      var y = years[j];
      var prev = plan[plan.length - 1];
      if (prev && prev.amount === y.amount && Math.abs(prev.allocPension - y.allocPension) < 1e-9) continue;
      plan.push({ fromYear: y.fromYear, amount: y.amount, allocPension: Math.round(y.allocPension * 100) / 100 });
    }
    if (!plan.length) plan.push({ fromYear: 0, amount: years[0].amount, allocPension: bestConst });
    return { savingsPlan: plan, optionalityAge: achieved, baselineAge: baseAge, changed: true };
  }

  // ---- Recommendation engine (this year's split by strategy) ----------
  function splitThreeWays(amount, allocPension) {
    var pension = amount * allocPension;
    var accessible = amount - pension;
    var isa = Math.min(20000, accessible);
    var gia = Math.max(0, accessible - isa);
    return { pension: Math.round(pension), isa: Math.round(isa), gia: Math.round(gia) };
  }
  function firstPeriodIdx(plan) { var idx = 0; for (var i = 1; i < plan.length; i++) if ((plan[i].fromYear || 0) < (plan[idx].fromYear || 0)) idx = i; return idx; }
  function ageLegacyForAlloc(inp, allocP) {
    var x = JSON.parse(JSON.stringify(inp));
    var plan = normalisePlan(x).map(function (s) { return { fromYear: s.fromYear || 0, amount: s.amount, allocPension: s.allocPension }; });
    plan[firstPeriodIdx(plan)].allocPension = allocP;
    x.savingsPlan = plan; x.plannedStopAge = null;
    var age = findOptionalityAge(x);
    if (age == null) return { age: null, legacy: -1e18, pensionAtAccess: 0 };
    var sim = simulate(x, age);
    return { age: age, legacy: sim.endWorth, pensionAtAccess: sim.pensionAtAccess };
  }
  // Returns the recommended this-year split for four strategies.
  function recommendation(inp) {
    var plan = normalisePlan(inp);
    var amount = plan[firstPeriodIdx(plan)].amount || 0;
    // one sweep gives freedom-min and legacy-max points; 0.5 and 1.0 land on grid
    var grid = {};
    var freedomAlloc = 0.30, bestAge = 1e9;
    for (var s = 0; s <= 100; s += 5) {
      var r = ageLegacyForAlloc(inp, s / 100); grid[s] = r;
      if (r.age != null && r.age < bestAge - 1e-9) { bestAge = r.age; freedomAlloc = s / 100; }
    }
    // Lowest Risk = biggest safety buffer WHILE keeping Freedom within ~2 years
    // of the earliest (otherwise "lowest risk" just becomes "retire much later").
    var riskAlloc = freedomAlloc, bestLegacy = -1e18;
    for (var s2 = 0; s2 <= 100; s2 += 5) {
      var g = grid[s2];
      if (g.age != null && g.age <= bestAge + 2 && g.legacy > bestLegacy + 1e-6) { bestLegacy = g.legacy; riskAlloc = s2 / 100; }
    }
    // Balanced = earliest Freedom Age that still leaves the pension on track to its
    // target (+ safety margin). Funds the pension only as much as it needs — never
    // over-weights the locked pension, so it never makes you work longer than needed.
    var reqBuffered = requiredPensionAtAccess(inp) * (1 + (inp.pensionBuffer || 0));
    var balancedAlloc = null, balBestAge = 1e9, bestPenGap = -1e18, fallbackAlloc = freedomAlloc;
    for (var s3 = 0; s3 <= 100; s3 += 5) {
      var gb = grid[s3]; if (gb.age == null) continue;
      if (gb.pensionAtAccess >= reqBuffered && gb.age < balBestAge - 1e-9) { balBestAge = gb.age; balancedAlloc = s3 / 100; }
      if (gb.pensionAtAccess > bestPenGap) { bestPenGap = gb.pensionAtAccess; fallbackAlloc = s3 / 100; } // if target never met
    }
    if (balancedAlloc == null) balancedAlloc = fallbackAlloc; // pension can't reach target: get as close as possible
    function pack(key, label, alloc, blurb) {
      var g = grid[Math.round(alloc * 100)] || ageLegacyForAlloc(inp, alloc);
      return { key: key, label: label, allocPension: alloc, split: splitThreeWays(amount, alloc), age: g.age, legacy: g.legacy, blurb: blurb };
    }
    var strategies = [
      pack('freedom', 'Maximise Freedom', freedomAlloc, 'Earliest Freedom Age.'),
      pack('balanced', 'Balanced', balancedAlloc, 'Earliest Freedom while the pension still hits its target.'),
      pack('pension', 'Maximise Pension', 1.00, 'Biggest long-term pension pot.'),
      pack('lowrisk', 'Lowest Risk', riskAlloc, 'Largest safety buffer at life expectancy.')
    ];
    return { amount: amount, strategies: strategies, recommendedKey: 'balanced' };
  }

  // ---- Freedom buffer: how much headroom before the Freedom Age slips -----
  function freedomBuffer(inp) {
    var base = findOptionalityAge(inp);
    if (base === null) return null;
    var tol = 1.0; // headroom before the Freedom Age slips by a whole year
    function ageSpend(d) { return findOptionalityAge(withPatch(inp, { bridgeSpending: inp.bridgeSpending + d, retirementSpending: inp.retirementSpending + d })); }
    var lo = 0, hi = Math.max(inp.retirementSpending, 50000) + 100000, g = 0;
    while (g < 12) { var ah = ageSpend(hi); if (ah != null && ah <= base + tol) { hi *= 1.7; g++; } else break; }
    for (var i = 0; i < 22; i++) { var m = (lo + hi) / 2; var a = ageSpend(m); if (a != null && a <= base + tol) lo = m; else hi = m; }
    var spendHeadroom = lo;
    function ageRet(d) { return findOptionalityAge(withPatch(inp, { pensionReturn: inp.pensionReturn - d, isaReturn: inp.isaReturn - d, giaReturn: inp.giaReturn - d, bridgeReturn: inp.bridgeReturn - d })); }
    var rlo = 0, rhi = 0.12, g2 = 0;
    while (g2 < 8) { var rah = ageRet(rhi); if (rah != null && rah <= base + tol) { rhi += 0.04; g2++; } else break; }
    for (var j = 0; j < 22; j++) { var rm = (rlo + rhi) / 2; var ra = ageRet(rm); if (ra != null && ra <= base + tol) rlo = rm; else rhi = rm; }
    return { spendHeadroom: Math.max(0, spendHeadroom), returnHeadroom: Math.max(0, rlo), baseAge: base };
  }


  // ---- Decision comparator: "I've got £X to invest — where should it go?" ----------
  // Simple gross basis: £X is deployed straight into each destination (ISA fills
  // its £20k limit first, the rest to GIA). No tax-relief modelling.
  function decisionComparator(inp, amount) {
    var dests = [
      { key: 'pension' }, { key: 'isa' }, { key: 'gia' }, { key: 'cash' }
    ];
    if ((inp.mortgage || 0) > 0) dests.push({ key: 'mortgage' });
    function addLump(x, account, amt) {
      if (amt <= 0) return;
      x.cashEvents = (x.cashEvents || []).concat([{ name: 'Lump sum', amount: amt, yearsFromNow: 0, direction: 'in', account: account }]);
    }
    var out = [];
    for (var i = 0; i < dests.length; i++) {
      var x = JSON.parse(JSON.stringify(inp));
      var k = dests[i].key, label, invested = amount;
      if (k === 'mortgage') { x.mortgage = Math.max(0, (x.mortgage || 0) - amount); label = 'Overpay mortgage'; }
      else if (k === 'pension') { addLump(x, 'pension', amount); label = 'Pension'; }
      else if (k === 'isa') {
        var toIsa = Math.min(20000, amount); addLump(x, 'isa', toIsa);
        var rest = amount - toIsa; addLump(x, 'gia', rest);
        label = rest > 0 ? 'ISA, then GIA' : 'ISA';
      }
      else { addLump(x, k, amount); label = k === 'gia' ? 'GIA' : 'Cash'; }
      var r = compute(x);
      out.push({ key: k, label: label, invested: invested, freedomAge: r.optionalityAge, survives: r.planSurvives,
        pension: r.pension.atAccess, bridge: r.accessible.atOptionality, income: r.retirement.sustainableIncome, legacy: r.endWorth });
    }
    out.sort(function (a, b) { var aa = a.freedomAge == null ? 1e6 : a.freedomAge, bb = b.freedomAge == null ? 1e6 : b.freedomAge; if (Math.abs(aa - bb) > 0.05) return aa - bb; return b.income - a.income; });
    if (out.length) out[0].best = true;
    return out;
  }

  // ---- Life milestones for the timeline -------------------------------
  function milestones(inp, result) {
    var m = [];
    m.push({ age: inp.currentAge, key: 'today', label: 'Today', section: 'personal' });
    (inp.cashEvents || []).forEach(function (e) {
      var evAge = (e.yearsFromNow != null) ? inp.currentAge + e.yearsFromNow : e.age;
      if (evAge != null && evAge >= inp.currentAge) m.push({ age: evAge, key: 'event', label: e.name, section: 'events' });
    });
    var coast = coastFireAge(inp);
    if (coast != null && coast >= inp.currentAge) m.push({ age: coast, key: 'coast', label: 'Coast FIRE', section: 'pension' });
    if (result && result.optionalityAge != null) m.push({ age: result.effectiveStop, key: 'freedom', label: 'Freedom Age', section: 'personal', highlight: true });
    m.push({ age: inp.pensionAccessAge, key: 'access', label: 'Pension access', section: 'personal' });
    if (inp.statePensionIncluded) m.push({ age: inp.statePensionAge, key: 'statepension', label: 'State Pension', section: 'personal' });
    m.push({ age: inp.lifeExpectancy, key: 'life', label: 'Life expectancy', section: 'personal' });
    m.sort(function (a, b) { return a.age - b.age; });
    return m;
  }

  // =====================================================================
  //  ISA / GIA BRIDGE PLANNER  ("Accessible Wealth")
  //  Independent module answering: at what age does my accessible (ISA/GIA)
  //  wealth first reach the portfolio needed to support my target income —
  //  i.e. full optionality before pension access?
  //
  //  All amounts are REAL (today's money) and `growth` is a REAL
  //  (after-inflation) return, so the crossover AGE is inflation-invariant.
  //  The UI's nominal view simply re-inflates every figure by (1+infl)^t,
  //  which scales the balance and the target equally and never moves the
  //  crossover — the correct behaviour for a real target.
  //
  //  Convention (documented in the UI):
  //   • Contributions come only from the phases, which STACK (are summed). A
  //     one-off — e.g. a lump sum — is just a single-year phase.
  //   • Contributions are ANNUAL (a Monthly option compounds 1/12 monthly),
  //     deployed during the year with growth applied AFTER, so a contribution
  //     appears — grown — in the next age's balance. These are the assumptions
  //     behind the worked example.
  // =====================================================================
  var BRIDGE_DEFAULTS = {
    currentAge: 35,
    currentBalance: 50000,         // engaged saver, top-quartile ISA/GIA in their 30s
    targetIncome: 43000,           // PLSA 'comfortable' single, today's money
    withdrawalRate: 0.035,         // safe withdrawal rate -> sizes the target pot
    growth: 0.07,                  // NOMINAL investment return (Base scenario)
    pensionAccessAge: 57,          // bridge end / pension access age (rises to 57 in 2028)
    inflation: 0.025,              // netted off the nominal return; also drives the display toggle
    phases: [
      { fromAge: 35, toAge: 57, annual: 10000 }   // ~830/month into ISA/GIA
    ],
    frequency: 'annual',
    mode: 'bridge',                // fund the gap to pension access (the relevant early-retirement framing)
    bridgeDepletion: 'full',
    partialRemainPct: 0.5,
    drawdownFromOptionality: true, // from optionality, draw the income and show the pot deplete
    stopDrawAtAccess: false,       // option: stop drawing from ISA/GIA at pension access (pension takes over)
    keepContributingAfterOptionality: false, // option: keep paying in the contribution phases even past optionality
    lifeExpectancy: 90,            // horizon for the drawdown view
    minResidual: 0,                // sequence-risk: buffer (today's money) to keep at pension access
    confidence: 0.90,              // sequence-risk Phase 2: target confidence for the stress-tested age
    scenarios: {
      // scenarios are explicit return + inflation + withdrawal-rate triples
      // (conservative = lower return, higher inflation, lower safe withdrawal rate)
      conservative: { growth: 0.05, inflation: 0.03, withdrawalRate: 0.03, contribScale: 1, enabled: false },
      optimistic:   { growth: 0.09, inflation: 0.02, withdrawalRate: 0.04, contribScale: 1, enabled: false }
    }
  };

  // Phases STACK: the contribution at an age is the SUM of every phase whose
  // range covers it. This lets a one-off (a single-year phase) sit on top of a
  // recurring phase without editing the recurring amount.
  function bridgeContribAt(bp, age) {
    // Phases are INCLUSIVE (From..To covers both ends) and STACK: the amount at an
    // age is the sum of every phase covering it. Overlaps add together on purpose
    // (a one-off lump is just a single-year phase); the per-row totals and the
    // year-by-year table make the combined figure visible.
    var ph = bp.phases || [], total = 0;
    for (var i = 0; i < ph.length; i++) {
      if (age >= ph[i].fromAge && age <= ph[i].toAge) total += (ph[i].annual || 0);
    }
    return total;
  }

  // Target portfolio at a given age. Perpetual: a constant pot = income / rate.
  // Bridge: the pot needed AT THIS AGE to fund the target income each year until
  // pension access, leaving a chosen remaining balance — so it falls as access
  // nears (fewer years left to self-fund), and the crossover comes earlier.
  function bridgeTargetAt(bp, sc, age, perpetualPot) {
    if (bp.mode !== 'bridge') return perpetualPot;
    if (bp.bridgeDepletion === 'preserve') return perpetualPot; // never touch capital
    var dr = (1 + sc.growth) / (1 + (bp.inflation || 0)) - 1; // real drawdown return (nominal − inflation)
    var N = bp.pensionAccessAge - age;        // years of bridge left
    var desiredRemain = bp.bridgeDepletion === 'full' ? 0
      : perpetualPot * (bp.partialRemainPct != null ? bp.partialRemainPct : 0.5);
    if (N <= 0) return desiredRemain;
    var income = bp.targetIncome;
    var pv;
    if (Math.abs(dr) < 1e-9) pv = income * N;
    else pv = income * (1 - Math.pow(1 + dr, -N)) / dr * (1 + dr); // annuity-due
    return pv + desiredRemain / Math.pow(1 + dr, N);
  }

  // Project one scenario year by year and locate the optionality crossover.
  function bridgeProject(bp, sc) {
    var curAge = bp.currentAge;
    var endAge = Math.max(bp.pensionAccessAge, curAge + 1);
    if (bp.drawdownFromOptionality) endAge = Math.max(endAge, bp.lifeExpectancy || 90); // run drawdown out to life expectancy
    var infl = (sc.inflation != null ? sc.inflation : bp.inflation) || 0;   // scenarios can set their own inflation
    var g = (1 + sc.growth) / (1 + infl) - 1;   // real return = nominal return deflated by inflation
    var wr = sc.withdrawalRate != null ? sc.withdrawalRate : bp.withdrawalRate;
    var scale = sc.contribScale != null ? sc.contribScale : 1;
    var perpetualPot = wr > 0 ? bp.targetIncome / wr : Infinity;
    var monthly = bp.frequency === 'monthly';

    // Optional secondary view: once optionality is reached, stop contributing
    // and start drawing the target income, to show how withdrawals shape the
    // pot in the years after optionality (up to pension access).
    var drawdown = !!bp.drawdownFromOptionality;
    var crossedInline = false;

    var rows = [];
    var running = bp.currentBalance;
    for (var a = curAge; a <= endAge; a++) {
      var target = bridgeTargetAt(bp, sc, a, perpetualPot);
      if (!crossedInline && isFinite(target) && running >= target) crossedInline = true;
      var walkedAway = drawdown && crossedInline;             // reached optionality and stopped saving
      var drawing = walkedAway && !((bp.stopDrawAtAccess === true) && a >= bp.pensionAccessAge); // optionally stop drawing at pension access
      var wdraw = drawing ? bp.targetIncome : 0;               // real income drawn (constant real -> keeps pace with inflation)
      // contributions (constant nominal £). Stop at optionality by default; keep paying the
      // phases past it when keepContributingAfterOptionality is on.
      var cNom = (walkedAway && !bp.keepContributingAfterOptionality) ? 0 : bridgeContribAt(bp, a) * scale;
      var c = cNom / Math.pow(1 + infl, a - curAge);           // its real value this year (declines with inflation)
      var prevBal = running, nextBal;
      if (monthly) {
        var mg = Math.pow(1 + g, 1 / 12) - 1, cm = c / 12, wm = wdraw / 12, r = running;
        for (var mo = 0; mo < 12; mo++) r = (r + cm - wm) * (1 + mg);
        nextBal = Math.max(0, r);
      } else {
        nextBal = Math.max(0, (running + c - wdraw) * (1 + g)); // net cashflow, then grow
      }
      rows.push({ age: a, balance: prevBal, target: target,
                  surplus: prevBal - target, income: prevBal * wr,
                  contribution: c, growth: nextBal - prevBal - c + wdraw, // market growth this year
                  withdraw: wdraw, drawing: drawing });
      running = nextBal;
    }

    // crossover: first age at which the projected balance meets the target
    var crossAge = null, crossAgeExact = null, crossBalance = null, crossTarget = null;
    for (var i = 0; i < rows.length; i++) {
      if (isFinite(rows[i].target) && rows[i].balance >= rows[i].target) {
        crossAge = rows[i].age; crossBalance = rows[i].balance; crossTarget = rows[i].target;
        // interpolate a fractional age between the last shortfall year and this one
        if (i === 0) { crossAgeExact = rows[0].age; }
        else {
          var gp = rows[i-1].balance - rows[i-1].target;   // gap the year before (< 0)
          var gc = rows[i].balance - rows[i].target;       // gap this year (>= 0)
          var denom = gc - gp;
          var f = denom !== 0 ? (-gp / denom) : 0;          // fraction of the year to the crossing
          crossAgeExact = Math.round((rows[i-1].age + Math.max(0, Math.min(1, f))) * 10) / 10;
        }
        break;
      }
    }
    var accessRow = null;
    for (var j = 0; j < rows.length; j++) if (rows[j].age === bp.pensionAccessAge) { accessRow = rows[j]; break; }
    if (!accessRow && rows.length) accessRow = rows[rows.length - 1];

    var depletionAge = null;   // first age the pot is exhausted while drawing income
    for (var k = 0; k < rows.length; k++) { if (rows[k].drawing && rows[k].balance <= 1) { depletionAge = rows[k].age; break; } }

    return {
      rows: rows,
      depletionAge: depletionAge,
      perpetualPot: perpetualPot,
      reached: crossAge !== null,
      crossAge: crossAge,
      crossAgeExact: crossAgeExact,
      crossBalance: crossBalance,
      crossTarget: crossTarget,
      yearsUntil: crossAge !== null ? crossAge - curAge : null,
      incomeAtCross: crossBalance !== null ? crossBalance * wr : null,
      surplusAtCross: crossBalance !== null ? crossBalance - crossTarget : null,
      balanceAtAccess: accessRow ? accessRow.balance : null,
      targetAtAccess: accessRow ? accessRow.target : perpetualPot,
      incomeAtAccess: accessRow ? accessRow.balance * wr : null
    };
  }

  // Full bridge plan: Base (top-level assumptions) + the two side scenarios.
  function bridgePlan(bp) {
    var base = bridgeProject(bp, { growth: bp.growth, withdrawalRate: bp.withdrawalRate, contribScale: 1 });
    var sc = bp.scenarios || {};
    var cons = sc.conservative || BRIDGE_DEFAULTS.scenarios.conservative;
    var opt = sc.optimistic || BRIDGE_DEFAULTS.scenarios.optimistic;
    return {
      base: base,
      conservative: bridgeProject(bp, cons),
      optimistic: bridgeProject(bp, opt),
      targetPot: bp.withdrawalRate > 0 ? bp.targetIncome / bp.withdrawalRate : Infinity
    };
  }

  // =====================================================================
  //  SEQUENCE-RISK / DRAWDOWN STRESS TESTING  (ISA/GIA bridge period)
  //
  //  The deterministic Base / Conservative / Optimistic projections all assume
  //  a CONSTANT annual return. Sequence risk is about ORDER, not average: the
  //  same set of returns can fund the bridge comfortably or run it dry purely
  //  depending on whether the bad years land early — while you're drawing an
  //  income and no longer have a wage to ride them out. This layer holds the
  //  plan fixed (stop at the deterministic work-optional / crossover age, draw
  //  the target income, constant real) and replays it against VARIABLE
  //  real-return sequences over the bridge years — the gap between stopping
  //  work and pension access.
  //
  //  Phase 1 (here): three deterministic stress scenarios — Normal, Poor Start
  //  and Crash — each reported with its year-by-year trajectory and whether the
  //  pot survives to pension access.
  //  Phase 2 (later): Monte Carlo / historical block-bootstrap across thousands
  //  of sequences, a success probability, a chosen confidence level and a
  //  stress-tested optionality age.
  //
  //  Convention (matches bridgeProject): each year the income is withdrawn
  //  first, then the remaining balance grows at that year's real return. Income
  //  is constant REAL — it keeps pace with inflation, exactly as elsewhere in
  //  the tool. A path SURVIVES if it funds every year's income to pension
  //  access without the balance dropping below the user's chosen minimum
  //  residual, and still holds at least that residual when the pension unlocks.
  // =====================================================================

  // Real (after-inflation) return from a nominal return + inflation.
  function realReturn(nominal, inflation) { return (1 + nominal) / (1 + (inflation || 0)) - 1; }

  // Phase-1 stress overlays. Each `shock` is a sequence of REAL returns applied
  // from the work-optional age; once it is exhausted, returns revert to the
  // plan's own real return (`baseReal`). Poor Start = a weak opening run (a
  // "lost" first few years); Crash = a severe first-year fall with a normal
  // V-shaped recovery — the classic "worst time to stop working" shock. These
  // are stress OVERLAYS, not mean-preserving reorderings: the point is to see
  // whether the bridge holds when markets turn against you right at the start.
  var BRIDGE_STRESS = [
    { key: 'normal',    label: 'Normal',     shock: [] },
    { key: 'poorStart', label: 'Poor start', shock: [-0.06, -0.10, -0.03] },
    { key: 'crash',     label: 'Crash',      shock: [-0.35, 0.18, 0.12] }
  ];

  // Simulate one drawdown path over the bridge years [startAge, accessAge).
  //   o = { startAge, accessAge, startBalance, income, minResidual, baseReal, shock }
  function bridgeDrawdownPath(o) {
    var bal = o.startBalance, income = o.income, minR = o.minResidual || 0;
    var rows = [], survived = true, failAge = null, low = Infinity;
    for (var a = o.startAge, i = 0; a < o.accessAge; a++, i++) {
      var r = (o.shock && i < o.shock.length) ? o.shock[i] : o.baseReal;
      var startBal = bal;
      var afterDraw = startBal - income;            // income taken at the start of the year
      var breached = afterDraw < minR - 1e-6;       // can't fund the year and hold the floor
      if (breached) { survived = false; if (failAge === null) failAge = a; }
      var endBal = Math.max(0, afterDraw) * (1 + r);
      low = Math.min(low, afterDraw);
      rows.push({ age: a, startBalance: round2(startBal), withdraw: round2(income), ret: r,
                  endBalance: round2(endBal), funded: !breached });
      bal = endBal;
    }
    var residual = bal;                              // balance when the pension unlocks
    if (residual < minR - 1e-6) survived = false;
    if (low === Infinity) low = bal;                 // no bridge years (crossover ≥ access)
    return { rows: rows, survived: survived, failAge: failAge,
             residual: round2(residual), lowPoint: round2(low),
             startAge: o.startAge, accessAge: o.accessAge };
  }

  // Full Phase-1 stress test for a bridge plan. Anchors on the deterministic
  // work-optional (crossover) age and the pot you'd actually hold there, then
  // runs each stress scenario. `minResidual` is the buffer (today's money) the
  // user wants left when the pension unlocks (defaults to bp.minResidual or 0).
  function bridgeStressTest(bp, minResidual) {
    var basePlan = bridgeProject(bp, { growth: bp.growth, withdrawalRate: bp.withdrawalRate, contribScale: 1 });
    var startAge = basePlan.crossAge;
    var accessAge = bp.pensionAccessAge;
    var minR = minResidual != null ? minResidual : (bp.minResidual || 0);
    var out = {
      reached: startAge != null,
      startAge: startAge,
      startAgeExact: basePlan.crossAgeExact,
      accessAge: accessAge,
      bridgeYears: startAge != null ? Math.max(0, accessAge - startAge) : null,
      minResidual: minR,
      income: bp.targetIncome,
      baseReal: realReturn(bp.growth, bp.inflation),
      scenarios: {}
    };
    if (startAge == null) return out;                // never work-optional: nothing to stress

    // pot held entering the crossover age (the money you'd have when you stop)
    var startBalance = basePlan.crossBalance;
    for (var i = 0; i < basePlan.rows.length; i++) {
      if (basePlan.rows[i].age === startAge) { startBalance = basePlan.rows[i].balance; break; }
    }
    out.startBalance = round2(startBalance);

    for (var s = 0; s < BRIDGE_STRESS.length; s++) {
      var sc = BRIDGE_STRESS[s];
      out.scenarios[sc.key] = bridgeDrawdownPath({
        startAge: startAge, accessAge: accessAge, startBalance: startBalance,
        income: bp.targetIncome, minResidual: minR, baseReal: out.baseReal, shock: sc.shock
      });
    }
    out.survivesNormal = out.scenarios.normal.survived;
    out.survivesBadStart = out.scenarios.poorStart.survived && out.scenarios.crash.survived;
    // the harshest scenario that fails (worst first), for the headline copy
    out.worstFail = !out.scenarios.crash.survived ? 'crash'
      : (!out.scenarios.poorStart.survived ? 'poorStart' : null);
    return out;
  }

  // =====================================================================
  //  SEQUENCE-RISK PHASE 2 — historical block-bootstrap simulation
  //
  //  Phase 1 replays three hand-picked stress paths. Phase 2 replays THOUSANDS
  //  of return sequences drawn from actual history, so the answer becomes a
  //  probability: across every plausible run of markets, in what share does the
  //  bridge fund the target income to pension access without breaching the
  //  chosen minimum residual? From that we read the earliest age that clears a
  //  target confidence — the STRESS-TESTED optionality age.
  //
  //  Return data: annual REAL total returns of US large-cap equity (S&P 500
  //  with dividends, deflated by US CPI), 1928–2024 — 97 observations, sourced
  //  from NYU Stern (Damodaran) S&P 500 total returns + US BLS CPI. Arithmetic
  //  mean ≈ 8.6% real, geometric ≈ 6.7%, volatility ≈ 19.6%, worst year −38.9%
  //  (2008), best +58.0% (1933). Used as the equity proxy for a 100%-growth
  //  bridge pot (global-developed equity has a similar shape at slightly lower
  //  vol; US large-cap gives the longest complete annual series, and its wider
  //  spread makes the test, if anything, a little harsher).
  //
  //  These are RAW historical returns — the simulation's average comes from
  //  history (~6.7% real), NOT from the user's own return assumption, which is
  //  used only to build the pot during the accumulation phase. Sequencing is
  //  preserved with a BLOCK bootstrap (stitch random 5-year runs) so crashes and
  //  recoveries cluster as they did historically, unlike i.i.d. sampling.
  //  Everything is seeded (deterministic) so the figures are stable and testable.
  // =====================================================================

  // Annual REAL total returns, US large-cap equity, 1928–2024 (n=97). See above.
  var HIST_EQUITY_REAL = [
    0.4630,-0.0830,-0.2336,-0.3829,0.0140,0.5804,-0.0416,0.4358,0.2999,-0.3759,0.3205,0.0030,
    -0.1129,-0.1692,0.0746,0.1787,0.1704,0.3277,-0.1545,-0.0804,-0.0222,0.1974,0.2913,0.1462,
    0.1595,-0.0199,0.5150,0.3313,0.0585,-0.1332,0.3981,0.1128,-0.0134,0.2539,-0.0971,0.2104,
    0.1493,0.1063,-0.1251,0.2008,0.0634,-0.1302,-0.0202,0.0941,0.1508,-0.1931,-0.3324,0.2557,
    0.1704,-0.1266,-0.0101,0.0649,0.1607,-0.1360,0.1339,0.1855,0.0177,0.2668,0.1628,0.0213,
    0.1195,0.2546,-0.0803,0.2498,0.0436,0.0677,-0.0124,0.3346,0.1911,0.3011,0.2632,0.1829,
    -0.1202,-0.1425,-0.2320,0.2547,0.0783,0.0138,0.1203,0.0261,-0.3887,0.2645,0.1301,-0.0107,
    0.1351,0.3020,0.1173,0.0128,0.1034,0.1911,-0.0647,0.2889,0.1662,0.2270,-0.2411,0.2110,
    0.2136
  ];
  var HIST_META = { label: 'US large-cap equity, real, 1928–2024', from: 1928, to: 2024,
    n: 97, arithMean: 0.0858, geoMean: 0.0671, vol: 0.1955, worst: -0.3887, best: 0.5804 };

  // Deterministic PRNG (mulberry32) — reproducible sims, stable UI, testable.
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // One block-bootstrap sequence of `n` real returns: stitch random contiguous
  // blocks of `blockLen` years (wrapping the series) so short-run clustering —
  // multi-year crashes and recoveries — is preserved, unlike i.i.d. draws.
  function blockBootstrap(series, n, blockLen, rng) {
    var out = [], L = series.length;
    while (out.length < n) {
      var start = Math.floor(rng() * L);
      for (var i = 0; i < blockLen && out.length < n; i++) out.push(series[(start + i) % L]);
    }
    return out;
  }

  // Pot you'd hold at `stopAge` if you keep contributing and DON'T draw down,
  // growing at your central (deterministic) real return — the accumulation phase
  // uses your own assumption; only the bridge drawdown is bootstrapped. Mirrors
  // bridgeProject's annual (contribute, then grow) convention.
  function bridgeBalanceIfStopAt(bp, stopAge) {
    var infl = bp.inflation || 0, g = realReturn(bp.growth, infl), bal = bp.currentBalance;
    var monthly = bp.frequency === 'monthly';
    var end = Math.round(stopAge);
    for (var a = bp.currentAge; a < end; a++) {
      var c = bridgeContribAt(bp, a) / Math.pow(1 + infl, a - bp.currentAge);
      if (monthly) { var mg = Math.pow(1 + g, 1 / 12) - 1, cm = c / 12, r = bal; for (var mo = 0; mo < 12; mo++) r = (r + cm) * (1 + mg); bal = r; }
      else bal = (bal + c) * (1 + g);
    }
    return bal;
  }

  // Monte-Carlo survival of the bridge if you stop at `stopAge`: draw the target
  // income (constant real) from the pot you'd hold there, against `trials`
  // bootstrapped historical real-return sequences, to pension access. Returns the
  // success rate (share funding every year AND holding ≥ minResidual at access)
  // plus p10/p50/p90 balance bands per bridge year for a fan chart.
  function bridgeSurvivalRateAt(bp, stopAge, minR, opts) {
    var accessAge = bp.pensionAccessAge;
    var years = Math.max(0, Math.round(accessAge) - Math.round(stopAge));
    var startBalance = bridgeBalanceIfStopAt(bp, stopAge);
    var income = bp.targetIncome, floor = minR || 0;
    if (years <= 0) {
      return { rate: startBalance >= floor - 1e-6 ? 1 : 0, years: 0, trials: 0,
               startBalance: startBalance, bands: [{ age: Math.round(stopAge), p10: startBalance, p50: startBalance, p90: startBalance }] };
    }
    var trials = opts.trials, blockLen = opts.blockLen, rng = mulberry32(opts.seed);
    var success = 0;
    var perYear = []; for (var k = 0; k <= years; k++) perYear.push([]);
    for (var t = 0; t < trials; t++) {
      var seq = blockBootstrap(HIST_EQUITY_REAL, years, blockLen, rng);
      var bal = startBalance, ok = true;
      perYear[0].push(bal);
      for (var i = 0; i < years; i++) {
        var afterDraw = bal - income;
        if (afterDraw < floor - 1e-6) ok = false;      // breached the floor funding this year
        bal = Math.max(0, afterDraw) * (1 + seq[i]);    // failed paths flatline at 0
        perYear[i + 1].push(bal);
      }
      if (ok && bal >= floor - 1e-6) success++;
    }
    var bands = perYear.map(function (arr, i) {
      arr.sort(function (a, b) { return a - b; });
      var q = function (p) { return arr[Math.min(arr.length - 1, Math.max(0, Math.round(p * (arr.length - 1))))]; };
      return { age: Math.round(stopAge) + i, p10: round2(q(0.10)), p50: round2(q(0.50)), p90: round2(q(0.90)) };
    });
    return { rate: success / trials, years: years, trials: trials, startBalance: round2(startBalance), bands: bands };
  }

  // Earliest age whose bridge clears the target confidence. Scans integer ages
  // (common random numbers across ages keep it smooth) and interpolates a
  // one-decimal age where the success curve crosses the confidence line.
  function stressTestedOptionalityAge(bp, confidence, minR, opts) {
    var accessAge = Math.round(bp.pensionAccessAge);
    var startScan = Math.ceil(bp.currentAge);
    var prevRate = null, prevAge = null;
    for (var a = startScan; a <= accessAge; a++) {
      var res = bridgeSurvivalRateAt(bp, a, minR, opts);
      if (res.rate >= confidence) {
        if (prevAge == null || res.rate === prevRate) return { age: a, exact: a, rateAt: res.rate };
        var f = (confidence - prevRate) / (res.rate - prevRate); f = Math.max(0, Math.min(1, f));
        return { age: a, exact: Math.round((prevAge + f) * 10) / 10, rateAt: res.rate };
      }
      prevRate = res.rate; prevAge = a;
    }
    return { age: null, exact: null, rateAt: prevRate };   // unreachable even at pension access
  }

  // Full Phase-2 simulation for the bridge planner.
  function bridgeSimulate(bp, o) {
    o = o || {};
    var opts = { trials: o.trials || 2000, blockLen: o.blockLen || 5, seed: (o.seed || 1234567) >>> 0 };
    var confidence = o.confidence != null ? o.confidence : (bp.confidence != null ? bp.confidence : 0.90);
    var minR = o.minResidual != null ? o.minResidual : (bp.minResidual || 0);
    var basePlan = bridgeProject(bp, { growth: bp.growth, withdrawalRate: bp.withdrawalRate, contribScale: 1 });
    var crossAge = basePlan.crossAge;
    var out = {
      reached: crossAge != null, crossAge: crossAge, crossAgeExact: basePlan.crossAgeExact,
      accessAge: Math.round(bp.pensionAccessAge), confidence: confidence, minResidual: minR,
      trials: opts.trials, blockLen: opts.blockLen, hist: HIST_META
    };
    if (crossAge == null) return out;
    var atCross = bridgeSurvivalRateAt(bp, crossAge, minR, opts);
    out.confidenceAtCrossover = atCross.rate;
    out.bands = atCross.bands;              // fan chart at the work-optional age
    out.bridgeYears = atCross.years;
    out.startBalance = atCross.startBalance;
    var st = stressTestedOptionalityAge(bp, confidence, minR, opts);
    out.stressAge = st.age;
    out.stressAgeExact = st.exact;
    out.stressAgeRate = st.rateAt;
    out.meetsAtCrossover = atCross.rate >= confidence;
    return out;
  }

  // =====================================================================
  //  PENSION COAST FIRE PLANNER
  //  Answers: when does my pension become self-sustaining — i.e. at what age
  //  can I stop (or cut) contributions and still hit my retirement objective?
  //
  //  The "required coast balance" at an age is the pension you'd need THEN to
  //  reach the target pot by the objective age with ZERO further contributions:
  //      required(age) = targetPot / (1 + g)^(objAge − age)
  //  It rises to `targetPot` at objAge. The projected pension (with your
  //  contributions) also rises; where the two meet is the COAST point.
  //  Same real-terms convention as the Bridge Planner (growth is real, so the
  //  coast age is inflation-invariant; the nominal view only re-inflates).
  // =====================================================================
  var COAST_DEFAULTS = {
    currentAge: 35,
    currentPension: 90000,         // engaged saver, top-quartile pension in their 30s
    phases: [
      { fromAge: 35, toAge: 60, annual: 12000 }   // strong ongoing pension contributions (employee + employer)
    ],
    growth: 0.07,                  // NOMINAL investment return (Base)
    inflation: 0.025,              // netted off the nominal return; also drives the display toggle
    pensionAccessAge: 57,          // when the pension can be accessed
    retirementAge: 65,             // objective age - when you want the target pot
    goalMode: 'income',            // 'pot' | 'income' (income is friendlier for new users)
    targetPot: 775000,             // fallback for pot mode
    targetIncome: 43000,           // PLSA 'comfortable' single (today's money)
    withdrawalRate: 0.035,         // (income - State Pension) / rate = required pot (income mode)
    statePensionAmount: 11900,     // full new State Pension ~2025/26 (today's money); 0 to exclude
    statePensionAge: 67,           // State Pension age
    lifeExpectancy: 90,            // sequence-risk: drawdown horizon for the pension stress test
    minResidual: 0,                // sequence-risk: buffer (today's money) to keep at life expectancy
    confidence: 0.90,              // sequence-risk Phase 2: target confidence for the stress-tested retirement age
    impactLevels: [5000, 10000, 15000],
    scenarios: {
      // scenarios are explicit return + inflation + withdrawal-rate triples
      // (conservative = lower return, higher inflation, lower safe withdrawal rate)
      conservative: { growth: 0.05, inflation: 0.03, withdrawalRate: 0.03, enabled: false },
      optimistic:   { growth: 0.09, inflation: 0.02, withdrawalRate: 0.04, enabled: false }
    }
  };

  function coastContribAt(cp, age) {
    // Phases are INCLUSIVE (From..To covers both ends) and STACK: the amount at an
    // age is the sum of every phase covering it. Overlaps add together on purpose
    // (a one-off lump is a single-year phase); per-row totals and the year-by-year
    // table make the combined figure visible.
    var ph = cp.phases || [], total = 0;
    for (var i = 0; i < ph.length; i++) {
      if (age >= ph[i].fromAge && age <= ph[i].toAge) total += (ph[i].annual || 0);
    }
    return total;
  }
  function coastObjAge(cp, sc) {
    var ra = (sc && sc.retirementAge != null) ? sc.retirementAge
      : (cp.retirementAge != null ? cp.retirementAge : cp.pensionAccessAge);
    return Math.max(cp.currentAge + 1, ra);
  }
  function coastTargetPot(cp, sc) {
    var wr = (sc && sc.withdrawalRate != null) ? sc.withdrawalRate : cp.withdrawalRate;
    if (cp.goalMode !== 'income') return cp.targetPot;
    var sp = cp.statePensionAmount || 0;                       // State Pension covers part of the income
    var privateIncome = Math.max(0, (cp.targetIncome || 0) - sp);
    // Perpetual pot to fund the income ABOVE the State Pension at the withdrawal rate.
    var pot = wr > 0 ? privateIncome / wr : Infinity;
    // Bridge-to-State-Pension: if the objective (retirement) age is BEFORE the
    // State Pension starts, the pension must ALSO replace the not-yet-received
    // State Pension for those in-between years — otherwise the pot is sized as
    // if the State Pension were in payment from the objective age. Add the
    // capital needed to self-fund the State Pension over the gap years, so the
    // required pot agrees with the year-by-year drawdown (which only nets off
    // the State Pension from statePensionAge). Discounted at the real return, to
    // match the drawdown mechanics; no effect when you retire at/after SP age.
    var objAge = coastObjAge(cp, sc);
    var spAge = cp.statePensionAge || 67;
    var gapYears = Math.max(0, spAge - objAge);
    if (sp > 0 && gapYears > 0 && isFinite(pot)) {
      var infl = (sc && sc.inflation != null ? sc.inflation : cp.inflation) || 0;
      var g = (1 + ((sc && sc.growth != null) ? sc.growth : cp.growth)) / (1 + infl) - 1;
      var bridge;
      if (Math.abs(g) < 1e-9) bridge = sp * gapYears;
      else bridge = sp * (1 - Math.pow(1 + g, -gapYears)) / g * (1 + g); // annuity-due
      pot += bridge;
    }
    return pot;
  }
  // Pension at the objective age if contributions cease at `stopAge`.
  function coastFinalIfStop(cp, sc, stopAge) {
    var infl = (sc.inflation != null ? sc.inflation : cp.inflation) || 0;
    var g = (1 + sc.growth) / (1 + infl) - 1, objAge = coastObjAge(cp, sc), running = cp.currentPension;
    for (var a = cp.currentAge; a < objAge; a++) {
      var cNom = (a < stopAge) ? coastContribAt(cp, a) : 0;
      var c = cNom / Math.pow(1 + infl, a - cp.currentAge);
      running = (running + c) * (1 + g);
    }
    return running;
  }

  function coastProject(cp, sc) {
    var infl = (sc.inflation != null ? sc.inflation : cp.inflation) || 0;   // scenarios can set their own inflation
    var g = (1 + sc.growth) / (1 + infl) - 1;   // real return = nominal return deflated by inflation
    var objAge = coastObjAge(cp, sc);
    var wr = (sc.withdrawalRate != null) ? sc.withdrawalRate : cp.withdrawalRate;
    var targetPot = coastTargetPot(cp, sc);

    // Project to a display horizon that runs past the objective so the chart/table
    // show the pension being drawn down after the target/retirement date.
    var horizonAge = Math.max(objAge, cp.horizonAge || 70);
    var sp = cp.statePensionAmount || 0;                       // State Pension (real, today's money)
    var spAge = cp.statePensionAge || 67;                      // age it starts
    // income the pension is meant to pay in retirement (today's money, constant real)
    var drawIncome = cp.goalMode === 'income' ? (cp.targetIncome || 0) : targetPot * wr;
    var rows = [], running = cp.currentPension, potAtObj = null, projAfterObj = null, coastDepletionAge = null;
    for (var a = cp.currentAge; a <= horizonAge; a++) {
      var yrsLeft = objAge - a;
      // required coast balance rises to the target at objAge, then holds flat beyond it
      var required = yrsLeft >= 0 ? targetPot / Math.pow(1 + g, yrsLeft) : targetPot;
      var retired = a >= objAge;                               // from the objective age you stop saving and start drawing
      var cNom = retired ? 0 : coastContribAt(cp, a);
      var c = cNom / Math.pow(1 + infl, a - cp.currentAge);    // constant-nominal contribution in real terms
      // withdrawal (constant real): full target income, less State Pension once it is in payment (income goals)
      var wdraw = retired ? Math.max(0, drawIncome - ((cp.goalMode === 'income' && a >= spAge) ? sp : 0)) : 0;
      var prevProj = running, nextProj = Math.max(0, (running + c - wdraw) * (1 + g));
      if (a === objAge) { potAtObj = prevProj; projAfterObj = nextProj; }
      if (coastDepletionAge == null && retired && wdraw > 0 && nextProj <= 1) coastDepletionAge = a;
      rows.push({ age: a, projected: prevProj, required: required,
                  surplus: prevProj - required, contribution: c, withdraw: wdraw,
                  growth: nextProj - prevProj - c + wdraw, income: prevProj * wr, // growth = market gain this year
                  postObjective: a > objAge, drawing: retired });
      running = nextProj;
    }

    // coast crossover: first age where projected ≥ required coast balance
    var coastAge = null, coastAgeExact = null, coastBalance = null;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].age > objAge) break;   // coasting must be achievable by the objective age
      if (rows[i].projected >= rows[i].required) {
        coastAge = rows[i].age; coastBalance = rows[i].required;
        if (i === 0) { coastAgeExact = rows[0].age; }
        else {
          var gp = rows[i-1].projected - rows[i-1].required;  // < 0
          var gc = rows[i].projected - rows[i].required;      // >= 0
          var denom = gc - gp;
          var f = denom !== 0 ? (-gp / denom) : 0;
          coastAgeExact = Math.round((rows[i-1].age + Math.max(0, Math.min(1, f))) * 10) / 10;
        }
        break;
      }
    }
    // pension at objAge WITH all contributions (value leaving the objective year)
    var finalProjected = projAfterObj != null ? projAfterObj
      : (rows.length ? (rows[rows.length - 1].projected + rows[rows.length - 1].contribution) * (1 + g) : running);
    // objAge row projected is the value entering objAge:
    if (potAtObj == null) potAtObj = rows.length ? rows[rows.length - 1].projected : running;

    var requiredNow = rows.length ? rows[0].required : targetPot;
    var yearsToObj = objAge - cp.currentAge;
    var meetsTarget = potAtObj >= targetPot - 1;

    return {
      rows: rows,
      objAge: objAge,
      targetPot: targetPot,
      withdrawalRate: wr,
      coastAge: coastAge,
      coastAgeExact: coastAgeExact,
      coasting: coastAge !== null && coastAge <= cp.currentAge,
      reached: coastAge !== null,
      coastBalance: coastBalance,
      yearsUntilCoast: coastAge !== null ? Math.max(0, coastAge - cp.currentAge) : null,
      shortfallNow: Math.max(0, requiredNow - cp.currentPension),
      potAtObj: potAtObj,
      incomeAtObj: potAtObj * wr,
      drawIncome: drawIncome,
      coastDepletionAge: coastDepletionAge,
      meetsTarget: meetsTarget,
      requiredNow: requiredNow
    };
  }

  // "If I stopped contributing at age X…" — pension at objAge for each stop age.
  function coastStopSchedule(cp, sc) {
    var objAge = coastObjAge(cp, sc), targetPot = coastTargetPot(cp, sc), out = [];
    for (var a = cp.currentAge; a <= objAge; a++) {
      var fin = coastFinalIfStop(cp, sc, a);
      out.push({ stopAge: a, finalPension: fin, meetsTarget: fin >= targetPot - 1,
                 yearsContributing: a - cp.currentAge });
    }
    return out;
  }

  // Compare flat annual contribution levels: coast age, final pot, income.
  function coastContributionImpact(cp, sc) {
    var levels = cp.impactLevels || [20000, 40000, 60000];
    return levels.map(function (lvl) {
      var x = JSON.parse(JSON.stringify(cp));
      x.phases = [{ fromAge: cp.currentAge, toAge: coastObjAge(cp, sc), annual: lvl }];
      var r = coastProject(x, sc);
      return { level: lvl, coastAge: r.coastAge, finalPension: r.potAtObj, income: r.incomeAtObj };
    });
  }

  function coastPlan(cp) {
    var baseSc = { growth: cp.growth, withdrawalRate: cp.withdrawalRate, retirementAge: cp.retirementAge };
    var sc = cp.scenarios || {};
    var cons = Object.assign({}, COAST_DEFAULTS.scenarios.conservative, sc.conservative);
    var opt = Object.assign({}, COAST_DEFAULTS.scenarios.optimistic, sc.optimistic);
    var base = coastProject(cp, baseSc);
    return {
      base: base,
      conservative: coastProject(cp, cons),
      optimistic: coastProject(cp, opt),
      stopSchedule: coastStopSchedule(cp, baseSc),
      targetPot: base.targetPot,
      objAge: base.objAge
    };
  }

  // =====================================================================
  //  SEQUENCE RISK — PENSION DRAWDOWN (Coast planner)
  //  The same idea as the bridge stress test, applied to the RETIREMENT
  //  drawdown: from the retirement age you draw your income (real, less the
  //  State Pension once it starts) against variable real returns, out to life
  //  expectancy. A bad run of markets early in retirement — while you're
  //  drawing income — can exhaust a pot that a flat-return line calls safe.
  //  Outputs deliberately reuse the bridge stress/sim FIELD NAMES so the UI
  //  block is shared: startAge/crossAge = retirement age, accessAge = life
  //  expectancy, bridgeYears = drawdown years.
  // =====================================================================
  function coastRetireAge(cp) {
    return Math.round(Math.max(cp.currentAge + 1, cp.retirementAge != null ? cp.retirementAge : cp.pensionAccessAge));
  }
  function coastRetireIncome(cp) {
    var targetPot = coastTargetPot(cp, {});
    return cp.goalMode === 'income' ? (cp.targetIncome || 0) : targetPot * cp.withdrawalRate;
  }
  // Pension pot at retAge if contributions continue to then (deterministic real return).
  function coastBalanceIfRetireAt(cp, retAge) {
    var infl = cp.inflation || 0, g = realReturn(cp.growth, infl), bal = cp.currentPension;
    var end = Math.round(retAge);
    for (var a = cp.currentAge; a < end; a++) {
      var c = coastContribAt(cp, a) / Math.pow(1 + infl, a - cp.currentAge);
      bal = (bal + c) * (1 + g);
    }
    return bal;
  }
  // One retirement drawdown path from retAge to lifeExp against a real-return
  // sequence. Net withdrawal = income less the State Pension once it starts.
  function coastDrawdownPath(o) {
    var bal = o.startBalance, minR = o.minResidual || 0;
    var rows = [], survived = true, failAge = null, low = Infinity;
    for (var a = o.retAge, i = 0; a < o.lifeExp; a++, i++) {
      var r = (o.shock && i < o.shock.length) ? o.shock[i] : o.baseReal;
      var sp = (a >= o.spAge) ? o.statePension : 0;
      var net = Math.max(0, o.income - sp);
      var startBal = bal;
      var afterDraw = startBal - net;
      var breached = afterDraw < minR - 1e-6;
      if (breached) { survived = false; if (failAge === null) failAge = a; }
      var endBal = Math.max(0, afterDraw) * (1 + r);
      low = Math.min(low, afterDraw);
      rows.push({ age: a, startBalance: round2(startBal), withdraw: round2(net), ret: r, endBalance: round2(endBal), funded: !breached });
      bal = endBal;
    }
    var residual = bal;
    if (residual < minR - 1e-6) survived = false;
    if (low === Infinity) low = bal;
    return { rows: rows, survived: survived, failAge: failAge, residual: round2(residual), lowPoint: round2(low), startAge: o.retAge, accessAge: o.lifeExp };
  }
  // Phase-1 deterministic stress overlays for the pension drawdown.
  function coastStressTest(cp, minResidual) {
    var retAge = coastRetireAge(cp);
    var lifeExp = Math.round(cp.lifeExpectancy || 90);
    var minR = minResidual != null ? minResidual : (cp.minResidual || 0);
    var baseReal = realReturn(cp.growth, cp.inflation);
    var income = coastRetireIncome(cp);
    var spAmt = cp.goalMode === 'income' ? (cp.statePensionAmount || 0) : 0;
    var spAge = cp.statePensionAge || 67;
    var startBalance = coastBalanceIfRetireAt(cp, retAge);
    var out = {
      reached: true, startAge: retAge, startAgeExact: retAge, accessAge: lifeExp,
      bridgeYears: Math.max(0, lifeExp - retAge), minResidual: minR, income: income,
      baseReal: baseReal, startBalance: round2(startBalance), spAge: spAge, statePension: spAmt, scenarios: {}
    };
    for (var s = 0; s < BRIDGE_STRESS.length; s++) {
      var sc = BRIDGE_STRESS[s];
      out.scenarios[sc.key] = coastDrawdownPath({ retAge: retAge, lifeExp: lifeExp, spAge: spAge,
        startBalance: startBalance, income: income, statePension: spAmt, minResidual: minR, baseReal: baseReal, shock: sc.shock });
    }
    out.survivesNormal = out.scenarios.normal.survived;
    out.survivesBadStart = out.scenarios.poorStart.survived && out.scenarios.crash.survived;
    out.worstFail = !out.scenarios.crash.survived ? 'crash' : (!out.scenarios.poorStart.survived ? 'poorStart' : null);
    return out;
  }
  // Monte-Carlo survival of the pension drawdown if you retire at retAge.
  function coastSurvivalRateAt(cp, retAge, minR, opts) {
    var lifeExp = Math.round(cp.lifeExpectancy || 90);
    var years = Math.max(0, lifeExp - Math.round(retAge));
    var startBalance = coastBalanceIfRetireAt(cp, retAge);
    var income = coastRetireIncome(cp), floor = minR || 0;
    var spAmt = cp.goalMode === 'income' ? (cp.statePensionAmount || 0) : 0, spAge = cp.statePensionAge || 67;
    if (years <= 0) {
      return { rate: startBalance >= floor - 1e-6 ? 1 : 0, years: 0, trials: 0, startBalance: startBalance,
               bands: [{ age: Math.round(retAge), p10: startBalance, p50: startBalance, p90: startBalance }] };
    }
    var trials = opts.trials, blockLen = opts.blockLen, rng = mulberry32(opts.seed);
    var success = 0, perYear = []; for (var k = 0; k <= years; k++) perYear.push([]);
    for (var t = 0; t < trials; t++) {
      var seq = blockBootstrap(HIST_EQUITY_REAL, years, blockLen, rng);
      var bal = startBalance, ok = true; perYear[0].push(bal);
      for (var i = 0; i < years; i++) {
        var a = Math.round(retAge) + i;
        var net = Math.max(0, income - ((a >= spAge) ? spAmt : 0));
        var afterDraw = bal - net;
        if (afterDraw < floor - 1e-6) ok = false;
        bal = Math.max(0, afterDraw) * (1 + seq[i]);
        perYear[i + 1].push(bal);
      }
      if (ok && bal >= floor - 1e-6) success++;
    }
    var bands = perYear.map(function (arr, i) {
      arr.sort(function (a, b) { return a - b; });
      var q = function (p) { return arr[Math.min(arr.length - 1, Math.max(0, Math.round(p * (arr.length - 1))))]; };
      return { age: Math.round(retAge) + i, p10: round2(q(0.10)), p50: round2(q(0.50)), p90: round2(q(0.90)) };
    });
    return { rate: success / trials, years: years, trials: trials, startBalance: round2(startBalance), bands: bands };
  }
  // Earliest retirement age whose pension drawdown clears the target confidence.
  function coastStressTestedRetireAge(cp, confidence, minR, opts) {
    var lifeExp = Math.round(cp.lifeExpectancy || 90);
    var floorAge = Math.max(Math.ceil(cp.currentAge), Math.round(cp.pensionAccessAge || 57));
    var prevRate = null, prevAge = null;
    for (var a = floorAge; a <= lifeExp; a++) {
      var res = coastSurvivalRateAt(cp, a, minR, opts);
      if (res.rate >= confidence) {
        if (prevAge == null || res.rate === prevRate) return { age: a, exact: a, rateAt: res.rate };
        var f = (confidence - prevRate) / (res.rate - prevRate); f = Math.max(0, Math.min(1, f));
        return { age: a, exact: Math.round((prevAge + f) * 10) / 10, rateAt: res.rate };
      }
      prevRate = res.rate; prevAge = a;
    }
    return { age: null, exact: null, rateAt: prevRate };
  }
  // Full Phase-2 pension-drawdown simulation (bridge-compatible fields).
  function coastSimulate(cp, o) {
    o = o || {};
    var opts = { trials: o.trials || 2000, blockLen: o.blockLen || 5, seed: (o.seed || 1234567) >>> 0 };
    var confidence = o.confidence != null ? o.confidence : (cp.confidence != null ? cp.confidence : 0.90);
    var minR = o.minResidual != null ? o.minResidual : (cp.minResidual || 0);
    var retAge = coastRetireAge(cp);
    var lifeExp = Math.round(cp.lifeExpectancy || 90);
    var out = {
      reached: true, crossAge: retAge, crossAgeExact: retAge, accessAge: lifeExp,
      confidence: confidence, minResidual: minR, trials: opts.trials, blockLen: opts.blockLen, hist: HIST_META
    };
    var atRet = coastSurvivalRateAt(cp, retAge, minR, opts);
    out.confidenceAtCrossover = atRet.rate;
    out.bands = atRet.bands;
    out.bridgeYears = atRet.years;
    out.startBalance = atRet.startBalance;
    var st = coastStressTestedRetireAge(cp, confidence, minR, opts);
    out.stressAge = st.age; out.stressAgeExact = st.exact; out.stressAgeRate = st.rateAt;
    out.meetsAtCrossover = atRet.rate >= confidence;
    return out;
  }

  // Combined LIFETIME view: accumulate both pots to the work-optional (retire) age,
  // then draw the target income down to age 90 — the accessible ISA/GIA pot bridges
  // the years until pension access, then the pension takes over. Values are REAL
  // (today's money); nominal returns are netted off inflation.
  function combinedPlan(bp, cp) {
    var inflB = bp.inflation || 0, inflC = cp.inflation || 0;
    var gB = (1 + bp.growth) / (1 + inflB) - 1;   // real return, accessible (ISA/GIA)
    var gC = (1 + cp.growth) / (1 + inflC) - 1;   // real return, pension
    var startAge = Math.min(bp.currentAge, cp.currentAge);
    var endAge = 90;
    var accessAge = bp.pensionAccessAge;
    var income = bp.targetIncome || 0;            // real annual retirement spend
    var spAmt = cp.statePensionAmount || 0;       // State Pension income (real)
    var spAge = cp.statePensionAge || 67;         // age it starts
    var bx = bridgePlan(bp).base.crossAge;        // work-optional age (accessible funds optionality)
    var retireAge = (bx != null) ? bx : accessAge;
    var pen = cp.currentPension || 0, acc = bp.currentBalance || 0;   // real balances
    var series = [];
    for (var a = startAge; a <= endAge; a++) {
      var penStart = pen, accStart = acc;
      var penIn = 0, accIn = 0, penOut = 0, accOut = 0;
      if (a < retireAge) {                          // accumulation
        penIn = coastContribAt(cp, a) / Math.pow(1 + inflC, a - cp.currentAge);
        accIn = bridgeContribAt(bp, a) / Math.pow(1 + inflB, a - bp.currentAge);
      } else {                                      // decumulation — draw income, less State Pension once it starts
        var need = income - (a >= spAge ? spAmt : 0);
        if (need < 0) need = 0;
        if (a < accessAge) {                        // pension locked -> from accessible only
          accOut = Math.min(accStart, need);
        } else {                                    // pension first, then top up from accessible
          penOut = Math.min(penStart, need);
          accOut = Math.min(accStart, need - penOut);
        }
      }
      var penMid = penStart + penIn - penOut, accMid = accStart + accIn - accOut;
      var penGrowth = penMid * gC, accGrowth = accMid * gB;
      var penEnd = Math.max(0, penMid + penGrowth), accEnd = Math.max(0, accMid + accGrowth);
      series.push({ age: a, pension: penStart, accessible: accStart, netWorth: penStart + accStart,
                    pensionIn: penIn, accessibleIn: accIn, pensionOut: penOut, accessibleOut: accOut,
                    pensionGrowth: penGrowth, accessibleGrowth: accGrowth,
                    pensionEnd: penEnd, accessibleEnd: accEnd,
                    contributions: penIn + accIn, withdrawals: penOut + accOut });
      pen = penEnd; acc = accEnd;
    }
    return { series: series, startAge: startAge, endAge: endAge, pensionAccessAge: accessAge,
             retireAge: retireAge, infl: inflC };
  }

  // =====================================================================
  // MORTGAGE OVERPAYMENT vs INVESTING — side calculator
  // ---------------------------------------------------------------------
  // Deliberately NOT a third dashboard. It answers one question: with the
  // same spare cash, am I better off overpaying the mortgage or investing?
  //
  // Conventions (all deliberate; all disclosed in the UI):
  //  • NOMINAL and MONTHLY. A mortgage is a nominal contract, so the whole
  //    comparison runs in cash terms. The display layer may deflate to
  //    today's money — both paths by the same factor, so the winner and the
  //    break-even rate never change.
  //  • Both paths see IDENTICAL cash every month: the contractual payment
  //    plus the spare. Overpaying SHORTENS THE TERM, it does not cut the
  //    payment (which is also what lenders do unless you ask otherwise), so
  //    the payment is the same on both paths.
  //  • Once a path's mortgage is gone, the freed payment is invested —
  //    otherwise overpaying would look bad merely because its money
  //    disappears from the comparison.
  //  • Spare cash the annual overpayment allowance turns away is invested
  //    instead of vanishing.
  //  • NET WEALTH = investments − outstanding debt, on BOTH paths. Never
  //    an investment balance set against "interest saved".
  // =====================================================================
  var MORTGAGE_DEFAULTS = {
    balance: 200000,           // outstanding mortgage
    rate: 0.045,               // annual interest rate
    termYears: 20,             // years left to run
    payment: null,             // monthly payment; null = derive from balance/rate/term
    spare: 2000,               // spare cash available
    spareFreq: 'annual',       // 'annual' | 'monthly'
    overpayLimitPct: 0.10,     // lender's penalty-free allowance, % of the balance each year (0 = none)
    growth: null,              // investment return; null = inherit the site's assumption
    fee: 0.0025,               // investment fee p.a.
    taxDrag: 0,                // ISA = none. GIA (taxable) is a later iteration.
    horizonMode: '10',         // '5' | '10' | '20' | 'term' | 'custom'
    horizonYears: 10,          // used when horizonMode is 'custom'
    rateChangeTo: null,        // optional: the rate changes to this...
    rateChangeAfterYears: null,// ...after this many years (e.g. a fix ending)
    _mv: 1
  };

  // Standard repayment mortgage payment.
  function mtgPmt(P, i, n) {
    if (n <= 0) return P;
    if (i <= 1e-12) return P / n;
    return P * i / (1 - Math.pow(1 + i, -n));
  }

  function mtgWith(o, patch) {
    var x = {}, k;
    for (k in o) if (Object.prototype.hasOwnProperty.call(o, k)) x[k] = o[k];
    for (k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) x[k] = patch[k];
    return x;
  }

  // One monthly loop running BOTH paths against the same cash, so they can
  // never accidentally be fed different amounts.
  function mortgageRun(o) {
    var months = Math.max(1, Math.round(o.months));
    var rMonthly = Math.pow(1 + Math.max(-0.99, o.netReturn), 1 / 12) - 1;
    var pay = o.payment;
    var balA = o.balance, balB = o.balance;     // A = overpay, B = invest
    var invA = 0, invB = 0, contribA = 0, contribB = 0;
    var intA = 0, intB = 0, extra = 0, capped = 0, spareCommitted = 0, freedA = 0, freedB = 0;
    var allowance = Infinity;
    var payoffA = null, payoffB = null;
    // gainA / gainB = what the spare cash has EARNED so far on each path:
    // interest avoided (plus growth on anything the allowance turned away) vs
    // investment growth. Both start at zero, and gainB − gainA is exactly the
    // net-wealth gap — cash conservation guarantees it.
    var rows = [{ m: 0, balA: balA, balB: balB, invA: 0, invB: 0, netA: -balA, netB: -balB,
                  gainA: 0, gainB: 0 }];
    for (var m = 0; m < months; m++) {
      var rate = (o.rateChangeMonth != null && m >= o.rateChangeMonth) ? o.rateChangeTo : o.rate;
      var i = rate / 12;
      // On a rate change the lender re-amortises. Size the new payment off the
      // NO-overpayment balance and use it on both paths, so overpaying still
      // buys a shorter term rather than a smaller payment.
      if (o.rateChangeMonth != null && m === o.rateChangeMonth && balB > 0)
        pay = mtgPmt(balB, i, Math.max(1, o.termMonths - m));
      // penalty-free allowance resets every 12 months, on the balance then owed
      if (m % 12 === 0) allowance = (o.limitPct > 0) ? o.limitPct * balA : Infinity;
      // Both paths commit the SAME spare cash, and they stop at the same moment:
      // once the overpaid mortgage is gone there is nothing left to overpay, so
      // the investing path stops paying in there too. Otherwise the two columns
      // show different amounts of committed cash and stop being comparable.
      var spare = (payoffA == null) ? (o.spareMonthly + ((m % 12 === 0) ? o.spareAnnual : 0)) : 0;
      spareCommitted += spare;

      var acA = balA * i, acB = balB * i;
      balA += acA; balB += acB; intA += acA; intB += acB;

      var payA = Math.min(balA, pay), payB = Math.min(balB, pay);
      balA -= payA; balB -= payB;

      // A: overpay what the allowance permits, invest the rest
      var want = Math.min(spare, balA);
      var op = Math.min(want, allowance);
      balA -= op; allowance -= op; extra += op; capped += (want - op);

      // The freed contractual payment still has to be accounted for: once the
      // overpaid mortgage is gone, path A no longer owes it while path B is
      // still handing it to the lender (which builds equity). Investing it on A
      // is what keeps the two paths spending identical cash — it is shown as its
      // own line, not folded into "spare cash committed".
      freedA += (pay - payA); freedB += (pay - payB);
      var intoA = (spare - op) + (pay - payA);   // cap overflow + the freed payment
      var intoB = spare + (pay - payB);
      invA = invA * (1 + rMonthly) + intoA; contribA += intoA;
      invB = invB * (1 + rMonthly) + intoB; contribB += intoB;

      if (balA <= 0.005) { balA = 0; if (payoffA == null) payoffA = m + 1; }
      if (balB <= 0.005) { balB = 0; if (payoffB == null) payoffB = m + 1; }
      rows.push({ m: m + 1, balA: balA, balB: balB, invA: invA, invB: invB,
                  netA: invA - balA, netB: invB - balB,
                  gainA: (intB - intA) + (invA - contribA), gainB: invB - contribB });
      if (o.stopWhenClear && balA === 0 && balB === 0) break;
    }
    return { rows: rows, balA: balA, balB: balB, invA: invA, invB: invB,
             contribA: contribA, contribB: contribB, intA: intA, intB: intB,
             extra: extra, capped: capped, payoffA: payoffA, payoffB: payoffB,
             spareCommitted: spareCommitted, freedA: freedA, freedB: freedB };
  }

  function mortgageHorizonYears(mp) {
    var mode = mp.horizonMode || 'custom';
    if (mode === 'term') return Math.max(1, mp.termYears || 1);
    if (mode === 'custom') return Math.max(1, mp.horizonYears || 1);
    var n = parseFloat(mode);
    return (isFinite(n) && n > 0) ? n : 10;
  }

  function mortgageOpts(mp, growth) {
    var termM = Math.max(1, Math.round((mp.termYears || 0) * 12));
    var bal = Math.max(0, mp.balance || 0);
    var i = (mp.rate || 0) / 12;
    var derived = mtgPmt(bal, i, termM);
    var pay = (mp.payment != null && mp.payment > 0) ? mp.payment : derived;
    // a payment that doesn't cover the interest never repays anything — fall
    // back to the contractual one rather than modelling a debt spiral
    var tooLow = (mp.payment != null && mp.payment > 0) && pay <= bal * i + 0.005;
    if (tooLow) pay = derived;
    var spare = Math.max(0, mp.spare || 0);
    var fee = Math.max(0, mp.fee || 0), drag = Math.max(0, mp.taxDrag || 0);
    return {
      balance: bal,
      rate: mp.rate || 0,
      termMonths: termM,
      payment: pay,
      derivedPayment: derived,
      paymentTooLow: tooLow,
      spareMonthly: mp.spareFreq === 'monthly' ? spare : 0,
      spareAnnual: mp.spareFreq === 'monthly' ? 0 : spare,
      limitPct: mp.overpayLimitPct != null ? Math.max(0, mp.overpayLimitPct) : 0,
      fee: fee, drag: drag,
      netReturn: growth - fee - drag,
      rateChangeMonth: (mp.rateChangeTo != null && mp.rateChangeAfterYears != null && mp.rateChangeAfterYears >= 0)
        ? Math.round(mp.rateChangeAfterYears * 12) : null,
      rateChangeTo: mp.rateChangeTo,
      stopWhenClear: false,
      months: 12
    };
  }

  // The whole comparison. Everything the module shows comes from here.
  function mortgagePlan(mp) {
    var growth = (mp.growth != null) ? mp.growth
               : (mp.growthFallback != null ? mp.growthFallback : 0.07);
    var o = mortgageOpts(mp, growth);
    var horizonYears = mortgageHorizonYears(mp);
    var H = Math.max(1, Math.round(horizonYears * 12));

    var need = (o.balance <= 0) ? 'Add your mortgage balance'
             : ((mp.termYears || 0) <= 0) ? 'Add the years left on your mortgage'
             : (((mp.spare || 0) <= 0) ? 'Add the spare cash you could use' : null);

    var run = mortgageRun(mtgWith(o, { months: H }));
    // Keep the overpayments going until the debt is gone — that is what the
    // mortgage-free date, the term cut and lifetime interest saved describe.
    var full = mortgageRun(mtgWith(o, { months: o.termMonths + 600, stopWhenClear: true }));

    var last = run.rows[run.rows.length - 1];
    var diff = last.netB - last.netA;            // + = investing ahead

    // Crossovers. With flat rates one path leads from month one, so a naive
    // "first month B is ahead" reads "overtakes in year 0" — useless. Track
    // meaningful lead changes instead (a tolerance kills the noise): the cap
    // binding, the overpaid mortgage clearing, or a rate change can genuinely
    // hand the lead back later.
    var tol = Math.max(50, o.balance * 0.0005);
    var crossings = [], sign = 0, firstLeader = null;
    for (var k = 1; k < run.rows.length; k++) {
      var d = run.rows[k].netB - run.rows[k].netA;
      var s = d > tol ? 1 : (d < -tol ? -1 : 0);
      if (s !== 0 && s !== sign) {
        if (sign !== 0) crossings.push({ month: k, winner: s > 0 ? 'invest' : 'overpay' });
        else firstLeader = s > 0 ? 'invest' : 'overpay';
        sign = s;
      }
    }
    var crossM = crossings.length ? crossings[crossings.length - 1] : null;

    // Break-even: the GROSS return at which the two paths end level. Solved on
    // the full model, so the overpayment cap, the timing and the reinvestment
    // of the freed payment are all in it — not just the mortgage rate echoed back.
    var diffAt = function (g) {
      var r = mortgageRun(mtgWith(o, { months: H, netReturn: g - o.fee - o.drag }));
      var l = r.rows[r.rows.length - 1];
      return l.netB - l.netA;
    };
    var breakEven = null;
    if (o.balance > 0 && (o.spareMonthly + o.spareAnnual) > 0) {
      var lo = 0, hi = 0.30;
      if (diffAt(lo) >= 0) breakEven = 0;
      else if (diffAt(hi) > 0) {
        for (var b = 0; b < 44; b++) {
          var mid = (lo + hi) / 2;
          if (diffAt(mid) > 0) hi = mid; else lo = mid;
        }
        breakEven = Math.round(((lo + hi) / 2) * 10000) / 10000;
      }
    }

    // Sensitivity — the site's own lower / central / higher return assumptions.
    var lowG  = (mp.lowGrowth  != null) ? mp.lowGrowth  : Math.max(0, growth - 0.02);
    var highG = (mp.highGrowth != null) ? mp.highGrowth : growth + 0.02;
    var sens = [{ key: 'low', growth: lowG }, { key: 'central', growth: growth }, { key: 'high', growth: highG }]
      .map(function (s) {
        var r = mortgageRun(mtgWith(o, { months: H, netReturn: s.growth - o.fee - o.drag }));
        var l = r.rows[r.rows.length - 1];
        return { key: s.key, growth: s.growth, diff: round2(l.netB - l.netA),
                 winner: (l.netB - l.netA) > 0 ? 'invest' : 'overpay' };
      });

    // yearly points for the chart (net wealth = investments − debt)
    var series = [];
    for (var y = 0; y * 12 < run.rows.length; y++) {
      var r0 = run.rows[y * 12];
      series.push({ year: y, saved: round2(r0.gainA), growth: round2(r0.gainB),
                    overpay: round2(r0.netA), invest: round2(r0.netB),
                    debtOverpay: round2(r0.balA), debtInvest: round2(r0.balB) });
    }
    var lastRow = run.rows[run.rows.length - 1];
    if (series.length === 0 || series[series.length - 1].year * 12 !== lastRow.m) {
      series.push({ year: Math.round((lastRow.m / 12) * 100) / 100,
                    saved: round2(lastRow.gainA), growth: round2(lastRow.gainB),
                    overpay: round2(lastRow.netA), invest: round2(lastRow.netB),
                    debtOverpay: round2(lastRow.balA), debtInvest: round2(lastRow.balB) });
    }

    return {
      ready: need == null, need: need,
      growth: growth, fee: o.fee, taxDrag: o.drag, netReturn: o.netReturn,
      horizonYears: horizonYears, months: H,
      payment: round2(o.payment), derivedPayment: round2(o.derivedPayment),
      paymentTooLow: o.paymentTooLow,
      spareAnnualTotal: round2(o.spareMonthly * 12 + o.spareAnnual),
      guaranteedReturn: o.rate,
      spareCommitted: round2(run.spareCommitted),
      spareStopMonth: (run.payoffA != null && run.payoffA < H) ? run.payoffA : null,
      overpay: {
        balance: round2(run.balA), interest: round2(run.intA), extra: round2(run.extra),
        investments: round2(run.invA), contributions: round2(run.contribA),
        freedInvested: round2(run.freedA),
        net: round2(lastRow.netA), capped: round2(run.capped)
      },
      invest: {
        balance: round2(run.balB), interest: round2(run.intB),
        investments: round2(run.invB), contributions: round2(run.contribB),
        freedInvested: round2(run.freedB),
        growthAmount: round2(run.invB - run.contribB), net: round2(lastRow.netB)
      },
      overpayGain: round2(lastRow.gainA), investGain: round2(lastRow.gainB),
      diff: round2(diff),
      winner: diff > 0 ? 'invest' : (diff < 0 ? 'overpay' : 'tie'),
      crossover: crossM, crossings: crossings, firstLeader: firstLeader,
      interestSaved: round2(run.intB - run.intA),
      interestSavedLifetime: round2(full.intB - full.intA),
      payoffMonths: full.payoffB, payoffMonthsOverpay: full.payoffA,
      termCutMonths: (full.payoffB != null && full.payoffA != null) ? (full.payoffB - full.payoffA) : null,
      extraLifetime: round2(full.extra),
      capBinding: run.capped > 0.5, cappedLifetime: round2(full.capped),
      breakEven: breakEven,
      sensitivity: sens,
      series: series
    };
  }

  var Engine = {
    DEFAULTS: DEFAULTS,
    BRIDGE_DEFAULTS: BRIDGE_DEFAULTS,
    bridgePlan: bridgePlan,
    bridgeProject: bridgeProject,
    bridgeStressTest: bridgeStressTest,
    bridgeDrawdownPath: bridgeDrawdownPath,
    realReturn: realReturn,
    BRIDGE_STRESS: BRIDGE_STRESS,
    bridgeSimulate: bridgeSimulate,
    bridgeSurvivalRateAt: bridgeSurvivalRateAt,
    stressTestedOptionalityAge: stressTestedOptionalityAge,
    bridgeBalanceIfStopAt: bridgeBalanceIfStopAt,
    blockBootstrap: blockBootstrap,
    HIST_EQUITY_REAL: HIST_EQUITY_REAL,
    HIST_META: HIST_META,
    COAST_DEFAULTS: COAST_DEFAULTS,
    coastPlan: coastPlan,
    coastProject: coastProject,
    coastStressTest: coastStressTest,
    coastSimulate: coastSimulate,
    coastSurvivalRateAt: coastSurvivalRateAt,
    coastBalanceIfRetireAt: coastBalanceIfRetireAt,
    combinedPlan: combinedPlan,
    simulate: simulate,
    findOptionalityAge: findOptionalityAge,
    sustainableOptionalityAge: sustainableOptionalityAge,
    compute: compute,
    opportunities: opportunities,
    risks: risks,
    optimisePlan: optimisePlan,
    recommendation: recommendation,
    freedomBuffer: freedomBuffer,
    decisionComparator: decisionComparator,
    milestones: milestones,
    requiredPensionAtAccess: requiredPensionAtAccess,
    requiredBridgeValue: requiredBridgeValue,
    coastFireAge: coastFireAge,
    MORTGAGE_DEFAULTS: MORTGAGE_DEFAULTS,
    mortgagePlan: mortgagePlan,
    mortgageRun: mortgageRun,
    mortgageHorizonYears: mortgageHorizonYears,
    mortgagePayment: mtgPmt
  };

  root.Engine = Engine;
  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
})(typeof window !== 'undefined' ? window : this);
