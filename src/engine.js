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

    // Tax & wrappers (this year) — used by the lump-sum comparator's net-cost view
    marginalRate: 0.20,            // basic rate — median UK earner
    salarySacrifice: true,         // pension via salary sacrifice (saves employee NI too)
    employeeNI: 0.08,              // employee NI main rate (April 2024)
    employerNIpass: 0.0,           // share of employer's NI passed into your pension
    pensionAllowanceLeft: 60000,   // pension annual allowance remaining this year
    isaAllowanceLeft: 20000,       // ISA allowance remaining this year

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
          // RETIREMENT: pension first, then accessible
          var draw2 = need;
          var fromPen = Math.min(pension, draw2); pension -= fromPen; draw2 -= fromPen;
          pensionOut += fromPen;
          var fromCash2 = Math.min(cash, draw2); cash -= fromCash2; draw2 -= fromCash2;
          var fromIsa2 = Math.min(isa, draw2); isa -= fromIsa2; draw2 -= fromIsa2;
          var fromGia2 = Math.min(gia, draw2); gia -= fromGia2; draw2 -= fromGia2;
          accessOut += (fromCash2 + fromIsa2 + fromGia2);
          if (draw2 > 0.5) { survived = false; if (failAge === null) failAge = a; }
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

  // Pension £ received per £1 of net (take-home) cost, given tax relief.
  function pensionUplift(inp) {
    if (inp.salarySacrifice) {
      var denom = Math.max(0.05, 1 - (inp.marginalRate || 0) - (inp.employeeNI || 0));
      return (1 + (inp.employerNIpass || 0)) / denom;      // e.g. 40%+2% → ~1.72×
    }
    return 1 / Math.max(0.05, 1 - (inp.marginalRate || 0)); // relief at source: 40% → ~1.67×
  }

  // ---- Decision comparator: "I've got £X of net cash — where should it go?" ----------
  // `amount` is NET take-home cash. Each destination deploys what that cash buys
  // after tax relief and wrapper allowances, so pension's relief is visible.
  function decisionComparator(inp, amount) {
    var isaLeft = inp.isaAllowanceLeft != null ? inp.isaAllowanceLeft : 20000;
    var penLeft = inp.pensionAllowanceLeft != null ? inp.pensionAllowanceLeft : 60000;
    var uplift = pensionUplift(inp);
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
      var k = dests[i].key, label, invested;
      if (k === 'mortgage') { x.mortgage = Math.max(0, (x.mortgage || 0) - amount); label = 'Overpay mortgage'; invested = amount; }
      else if (k === 'pension') {
        var netForPen = Math.min(amount, penLeft / uplift);   // net cash that fits the allowance
        var penIn = netForPen * uplift;
        addLump(x, 'pension', penIn);
        var restNet = amount - netForPen;
        addLump(x, 'gia', restNet);
        invested = penIn + restNet;
        label = 'Pension' + (restNet > 0 ? ' + GIA' : '') + (uplift > 1.01 ? ' (+tax relief)' : '');
      }
      else if (k === 'isa') {
        var toIsa = Math.min(isaLeft, amount); addLump(x, 'isa', toIsa);
        var rest = amount - toIsa; addLump(x, 'gia', rest);
        invested = amount; label = rest > 0 ? 'ISA, then GIA' : 'ISA';
      }
      else { addLump(x, k, amount); invested = amount; label = k === 'gia' ? 'GIA' : 'Cash'; }
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

  var Engine = {
    DEFAULTS: DEFAULTS,
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
    pensionUplift: pensionUplift,
    milestones: milestones,
    requiredPensionAtAccess: requiredPensionAtAccess,
    requiredBridgeValue: requiredBridgeValue,
    coastFireAge: coastFireAge
  };

  root.Engine = Engine;
  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
})(typeof window !== 'undefined' ? window : this);
