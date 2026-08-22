const Engine = require('./src/engine.js');

function money(x){ return '£' + Math.round(x).toLocaleString('en-GB'); }
function line(){ console.log('-'.repeat(60)); }

const inp = JSON.parse(JSON.stringify(Engine.DEFAULTS));
const r = Engine.compute(inp);

console.log('DEFAULT SCENARIO');
line();
console.log('Optionality age      :', r.optionalityAge, r.achievable ? '' : '(UNREACHABLE)');
console.log('Confidence           :', r.confidence);
console.log('Years early vs target:', r.yearsEarlyLate);
console.log('End-of-life worth    :', money(r.endWorth));
line();
console.log('Pension current      :', money(r.pension.current));
console.log('Pension @ access     :', money(r.pension.atAccess));
console.log('Pension required     :', money(r.pension.required));
console.log('Pension status       :', r.pension.status);
console.log('Coast FIRE age       :', r.pension.coastFireAge);
line();
console.log('Accessible now       :', money(r.accessible.current));
console.log('Accessible @ optional:', money(r.accessible.atOptionality));
console.log('Required bridge value:', money(r.accessible.requiredBridge));
console.log('Remaining @ access   :', money(r.accessible.remainingAtAccess));
console.log('Accessible status    :', r.accessible.status);
line();
console.log('Sustainable ret income:', money(r.retirement.sustainableIncome), '(target', money(r.retirement.target)+')');
console.log('  pension part       :', money(r.retirement.pensionIncome));
console.log('  access part        :', money(r.retirement.accessIncome));
console.log('  state pension      :', money(r.retirement.statePension));
line();

// Monotonicity check: survival should be false below optionality age, true at/above.
const oa = r.optionalityAge;
console.log('Monotonicity around optionality age', oa);
[oa-1, oa-0.2, oa, oa+0.2, oa+1].forEach(function(age){
  if (age < inp.currentAge) return;
  const s = Engine.simulate(inp, age);
  console.log('  stop@'+age.toFixed(1)+' -> survived', s.survived, '  endWorth', money(s.endWorth));
});
line();

// Opportunities
console.log('OPPORTUNITIES (months earlier):');
Engine.opportunities(inp).forEach(o => console.log('  '+o.deltaMonths+'m  '+o.label));
line();
console.log('RISKS (months later):');
Engine.risks(inp).forEach(o => console.log('  '+(o.breaks?'BREAKS':o.deltaMonths+'m')+'  '+o.label));
line();

// Sanity assertions
let fails = 0;
function assert(cond, msg){ if(!cond){ console.log('FAIL:', msg); fails++; } }
assert(r.optionalityAge !== null, 'default scenario should be achievable');
assert(r.optionalityAge >= inp.currentAge && r.optionalityAge <= inp.lifeExpectancy, 'optionality age in range');
assert(Engine.simulate(inp, r.optionalityAge+0.5).survived, 'survives above optionality age');
assert(r.pension.atAccess > 0, 'pension at access positive');
assert(r.endWorth >= -1, 'plan does not end deeply negative at optionality age');
// last accumulation year: contributions should stop after stop age
const stopRow = r.rows.find(x => x.phase === 'bridge');
if (stopRow) assert(stopRow.contributions === 0, 'no ISA/GIA contributions during bridge');
console.log(fails === 0 ? 'ALL ASSERTIONS PASSED' : (fails + ' ASSERTION(S) FAILED'));

// Edge: very high spending should push optionality late or unreachable
const greedy = JSON.parse(JSON.stringify(inp));
greedy.bridgeSpending = 200000; greedy.retirementSpending = 200000;
const gr = Engine.compute(greedy);
console.log('High-spend (£200k) optionality age:', gr.optionalityAge);

// Edge: no earn-out
const noEarn = JSON.parse(JSON.stringify(inp));
noEarn.cashEvents = [];
const ne = Engine.compute(noEarn);
console.log('No earn-out optionality age       :', ne.optionalityAge);

// ===== ISA/GIA Bridge Planner =====
line();
console.log('BRIDGE PLANNER — worked example');
const bp = { currentAge:35, currentBalance:122000, targetIncome:80000, withdrawalRate:0.05, growth:0.07, pensionAccessAge:60, inflation:0.025,
  phases:[{fromAge:35,toAge:36,annual:20000},{fromAge:36,toAge:36,annual:400000},{fromAge:37,toAge:45,annual:40000},{fromAge:46,toAge:60,annual:0}],
  frequency:'annual', mode:'perpetual', bridgeDepletion:'full', partialRemainPct:0.5, drawdownFromOptionality:false,
  scenarios:{ conservative:{growth:0.05,withdrawalRate:0.04,contribScale:1,enabled:false}, optimistic:{growth:0.09,withdrawalRate:0.06,contribScale:1,enabled:false} } };
const plan = Engine.bridgePlan(bp);
console.log('Target pot        :', money(plan.targetPot));
console.log('Crossover age     :', plan.base.crossAge, '(expected 52)');
console.log('Balance @ cross   :', money(plan.base.crossBalance));
console.log('Income @ cross    :', money(plan.base.incomeAtCross)+'/yr');
console.log('Balance @ access  :', money(plan.base.balanceAtAccess));
console.log('Conservative/Optimistic cross:', plan.conservative.crossAge, '/', plan.optimistic.crossAge);
let bfails = 0;
function bassert(c,m){ if(!c){ console.log('FAIL:', m); bfails++; } }
bassert(plan.base.crossAge === 52, 'worked example crosses at 52 (nominal 7% / 2.5% inflation)');
bassert(plan.base.crossAgeExact != null && plan.base.crossAgeExact > 51 && plan.base.crossAgeExact <= 52, 'interpolated crossover age sits in the year before the integer crossing (got '+plan.base.crossAgeExact+')');
bassert(Math.round(plan.base.crossAgeExact*10)/10 === plan.base.crossAgeExact, 'crossAgeExact is rounded to one decimal');
bassert(Math.abs(plan.targetPot - 1600000) < 1, 'target pot = £1.6m at £80k / 5% (today money)');
bassert(Engine.bridgePlan(Object.assign(JSON.parse(JSON.stringify(bp)),{growth:0.10})).base.crossAge < plan.base.crossAge, 'higher nominal return crosses earlier');
var bInflHi = Engine.bridgePlan(Object.assign(JSON.parse(JSON.stringify(bp)),{inflation:0.05})).base.crossAge;
bassert(bInflHi == null || bInflHi > plan.base.crossAge, 'higher inflation pushes crossover later');
const bpFull = Object.assign({}, JSON.parse(JSON.stringify(bp)), { mode:'bridge', bridgeDepletion:'full' });
bassert(Engine.bridgePlan(bpFull).base.crossAge < 52, 'bridge full-depletion is earlier than perpetual');
const bpPres = Object.assign({}, JSON.parse(JSON.stringify(bp)), { mode:'bridge', bridgeDepletion:'preserve' });
bassert(Engine.bridgePlan(bpPres).base.crossAge === 52, 'bridge preserve-capital equals perpetual');
console.log(bfails === 0 ? 'ALL BRIDGE ASSERTIONS PASSED' : (bfails + ' BRIDGE ASSERTION(S) FAILED'));

// ===== Pension Coast FIRE Planner =====
line();
console.log('COAST PLANNER — worked example');
const cp = { currentAge:35, currentPension:232000, growth:0.095, inflation:0.025, pensionAccessAge:57, retirementAge:60, goalMode:'pot', targetPot:3000000, targetIncome:80000, withdrawalRate:0.04, impactLevels:[20000,40000,60000],
  phases:[{fromAge:35,toAge:36,annual:90000},{fromAge:37,toAge:40,annual:60000},{fromAge:41,toAge:60,annual:20000}],
  scenarios:{ conservative:{growth:0.05,withdrawalRate:0.035,retirementAge:62,enabled:false}, optimistic:{growth:0.09,withdrawalRate:0.045,retirementAge:58,enabled:false} } };
const cplan = Engine.coastPlan(cp);
console.log('Coast age (9.5% nominal):', cplan.base.coastAge, '(expected 41)');
console.log('Target pot        :', money(cplan.targetPot), 'at', cplan.objAge);
console.log('Pot @ objective   :', money(cplan.base.potAtObj));
let cfails = 0;
function cassert(c,m){ if(!c){ console.log('FAIL:', m); cfails++; } }
cassert(cplan.base.coastAge === 41, 'worked example coasts at 41 with a healthy nominal return');
cassert(cplan.base.coastAgeExact != null && cplan.base.coastAgeExact > 40 && cplan.base.coastAgeExact <= 41, 'interpolated coast age sits in the year before the integer crossing (got '+cplan.base.coastAgeExact+')');
cassert(cplan.targetPot === 3000000, 'pot-mode target = £3m (today money)');
const cInc = Object.assign({}, JSON.parse(JSON.stringify(cp)), { goalMode:'income' });
cassert(Math.abs(Engine.coastPlan(cInc).targetPot - 2000000) < 1, 'income mode £80k / 4% = £2m required');
var cHiG = Engine.coastPlan(Object.assign(JSON.parse(JSON.stringify(cp)), {growth:0.12})).base.coastAge;
cassert(cHiG != null && cHiG <= cplan.base.coastAge, 'higher nominal return coasts no later');
// scenarios carry their own inflation (conservative = lower return AND higher inflation)
const scDef = JSON.parse(JSON.stringify(Engine.COAST_DEFAULTS));
const scPlan = Engine.coastPlan(scDef);
const realOf = (gr, inf) => (1+gr)/(1+inf)-1;
cassert(realOf(scDef.scenarios.conservative.growth, scDef.scenarios.conservative.inflation) < realOf(scDef.growth, scDef.inflation), 'conservative real return is below base');
cassert(realOf(scDef.scenarios.optimistic.growth, scDef.scenarios.optimistic.inflation) > realOf(scDef.growth, scDef.inflation), 'optimistic real return is above base');
cassert(scPlan.conservative.coastAge == null || scPlan.base.coastAge == null || scPlan.conservative.coastAge >= scPlan.base.coastAge, 'conservative coasts no earlier than base');
cassert(scPlan.optimistic.coastAge == null || scPlan.base.coastAge == null || scPlan.optimistic.coastAge <= scPlan.base.coastAge, 'optimistic coasts no later than base (when both reach)');
console.log('Scenario coast ages (defaults): base', scPlan.base.coastAge, '· conservative', scPlan.conservative.coastAge, '· optimistic', scPlan.optimistic.coastAge);
console.log(cfails === 0 ? 'ALL COAST ASSERTIONS PASSED' : (cfails + ' COAST ASSERTION(S) FAILED'));

// ===== Coast: State Pension timing in the required pot =====
line();
console.log('COAST — State Pension timing in the required pot');
let sfails = 0; function sassert(c,m){ if(!c){ console.log('FAIL:', m); sfails++; } }
const spBase = { currentAge:35, currentPension:200000, growth:0.09, inflation:0.025, pensionAccessAge:57,
  goalMode:'income', targetIncome:70000, withdrawalRate:0.04, statePensionAmount:11900, statePensionAge:67,
  phases:[{fromAge:35,toAge:60,annual:12000}], scenarios:JSON.parse(JSON.stringify(Engine.COAST_DEFAULTS.scenarios)) };
// retire BEFORE State Pension age -> pot must exceed the naive (income - SP)/wr,
// because the pension has to self-fund the full income until the SP starts.
const early = Object.assign({}, JSON.parse(JSON.stringify(spBase)), { retirementAge:60 });
const naive = (early.targetIncome - early.statePensionAmount) / early.withdrawalRate; // 1,452,500
const potEarly = Engine.coastPlan(early).targetPot;
const gReal = (1+early.growth)/(1+early.inflation) - 1;
const gapYrs = early.statePensionAge - early.retirementAge; // 7
const expectedBridge = early.statePensionAmount * (1 - Math.pow(1+gReal, -gapYrs)) / gReal * (1+gReal); // annuity-due
console.log('Retire 60, SP from 67: naive', money(naive), '-> corrected', money(potEarly), '( +'+money(potEarly-naive)+' bridge )');
sassert(potEarly > naive + 1, 'required pot exceeds naive (income - SP)/wr when retiring before State Pension age');
sassert(Math.abs(potEarly - (naive + expectedBridge)) < 1, 'corrected pot = perpetual pot + annuity-due bridge for the SP gap years');
// retire AT/AFTER State Pension age -> no gap, pot unchanged from the naive formula
const late = Object.assign({}, JSON.parse(JSON.stringify(spBase)), { retirementAge:67 });
sassert(Math.abs(Engine.coastPlan(late).targetPot - naive) < 1, 'no bridge when retiring at/after State Pension age');
// no State Pension -> no bridge, pot = income / wr
const noSp = Object.assign({}, JSON.parse(JSON.stringify(early)), { statePensionAmount:0 });
sassert(Math.abs(Engine.coastPlan(noSp).targetPot - early.targetIncome/early.withdrawalRate) < 1, 'no State Pension -> pot = income / wr, no bridge');
// pot-mode target is untouched by the fix
const potMode = Object.assign({}, JSON.parse(JSON.stringify(early)), { goalMode:'pot', targetPot:1234567 });
sassert(Engine.coastPlan(potMode).targetPot === 1234567, 'pot-mode target unchanged by State Pension timing');
console.log(sfails === 0 ? 'ALL SP-TIMING ASSERTIONS PASSED' : (sfails + ' SP-TIMING ASSERTION(S) FAILED'));

// ===== Nominal-return model: inflation genuinely bites =====
line();
console.log('NOMINAL-RETURN MODEL / INFLATION');
let rfails = 0; function rassert(c,m){ if(!c){ console.log('FAIL:', m); rfails++; } }
// £100k, 0% nominal return, 0% inflation, 25y -> stays £100k
const rn = JSON.parse(JSON.stringify(Engine.COAST_DEFAULTS));
rn.currentAge = 35; rn.retirementAge = 60; rn.currentPension = 100000; rn.growth = 0; rn.inflation = 0;
rn.phases = [{ fromAge:35, toAge:60, annual:0 }]; rn.goalMode = 'pot'; rn.targetPot = 100000;
console.log('£100k @ 0% nominal, 0% inflation, 25y -> real pot:', money(Engine.coastPlan(rn).base.potAtObj));
rassert(Math.round(Engine.coastPlan(rn).base.potAtObj) === 100000, '£100k at 0% nominal & 0% inflation stays £100k');
// inflation BITES: nominal return fixed, higher inflation -> smaller real pot
const iLo = Engine.coastPlan(Object.assign(JSON.parse(JSON.stringify(rn)), { growth:0.07, inflation:0.01 }));
const iHi = Engine.coastPlan(Object.assign(JSON.parse(JSON.stringify(rn)), { growth:0.07, inflation:0.06 }));
console.log('7% nominal: real pot @1% infl', money(iLo.base.potAtObj), 'vs @6% infl', money(iHi.base.potAtObj));
rassert(iLo.base.potAtObj > iHi.base.potAtObj + 1, 'higher inflation shrinks the real pot (nominal return held fixed)');
// same REAL return via different nominal/inflation pairs -> same real pot
const realA = Engine.coastPlan(Object.assign(JSON.parse(JSON.stringify(rn)), { growth:0.05, inflation:0.02 }));
const nomB = (1.05/1.02)*1.04 - 1; // gives the same real return at 4% inflation
const realB = Engine.coastPlan(Object.assign(JSON.parse(JSON.stringify(rn)), { growth:nomB, inflation:0.04 }));
rassert(Math.abs(realA.base.potAtObj - realB.base.potAtObj) < 5, 'same real return (different nominal+inflation) gives the same real pot');
console.log(rfails === 0 ? 'ALL INFLATION ASSERTIONS PASSED' : (rfails + ' INFLATION ASSERTION(S) FAILED'));

// bridge drawdown option leaves the crossover age unchanged, changes later pot
const bpd = Object.assign({}, JSON.parse(JSON.stringify(Engine.BRIDGE_DEFAULTS)), { drawdownFromOptionality:true });
const bBase = Engine.bridgePlan(JSON.parse(JSON.stringify(Engine.BRIDGE_DEFAULTS))).base;
const bDraw = Engine.bridgePlan(bpd).base;
console.log('Bridge drawdown: crossover', bDraw.crossAge, '(unchanged '+ (bDraw.crossAge===bBase.crossAge) +') · balance@access', money(bDraw.balanceAtAccess), 'vs', money(bBase.balanceAtAccess), 'without');

// ===== Sequence-risk / drawdown stress testing (Phase 1) =====
line();
console.log('SEQUENCE-RISK STRESS TEST (bridge period)');
let xfails = 0; function xassert(c,m){ if(!c){ console.log('FAIL:', m); xfails++; } }
const sbp = JSON.parse(JSON.stringify(Engine.BRIDGE_DEFAULTS));
const sBase = Engine.bridgePlan(sbp).base;
const st = Engine.bridgeStressTest(sbp, 0);
console.log('Work-optional age :', st.startAge, '(exact '+st.startAgeExact+')  bridge', st.bridgeYears, 'yrs to access', st.accessAge);
console.log('Pot at crossover  :', money(st.startBalance), '· base real return', (st.baseReal*100).toFixed(2)+'%');
['normal','poorStart','crash'].forEach(function(k){ const s = st.scenarios[k];
  console.log('  '+k.padEnd(10)+' survived '+s.survived+'  residual '+money(s.residual)+(s.failAge!=null?'  runs dry @'+s.failAge:'')); });
console.log('Base projection: '+(st.survivesNormal?'Yes':'No')+' · Bad early markets: '+(st.survivesBadStart?'Yes':'No'));

// anchors on the deterministic crossover
xassert(st.reached === true, 'default plan reaches a work-optional age to stress');
xassert(st.startAge === sBase.crossAge, 'stress test starts at the deterministic crossover age');
xassert(st.bridgeYears === st.accessAge - st.startAge, 'bridge years = access age − start age');
xassert(st.scenarios.normal.rows.length === st.bridgeYears, 'one row per bridge year');
// Normal (shock=[]) must reproduce the deterministic projection's balance at access
xassert(Math.abs(st.scenarios.normal.residual - sBase.balanceAtAccess) < 1,
  'Normal residual reproduces the base projection balance @access ('+money(st.scenarios.normal.residual)+' vs '+money(sBase.balanceAtAccess)+')');
xassert(st.survivesNormal === true, 'Normal scenario survives to access at the default plan');
// Stress genuinely bites: bad early markets fail where Normal survives
xassert(st.scenarios.crash.residual <= st.scenarios.normal.residual, 'a crash never leaves more than the normal path');
xassert(st.scenarios.poorStart.residual <= st.scenarios.normal.residual, 'a poor start never leaves more than the normal path');
xassert(st.survivesBadStart === false, 'default plan does NOT survive both bad-start scenarios (there is real sequence risk)');
xassert(st.worstFail === 'crash', 'the crash is flagged as the harshest failing scenario');
// income drawn is the constant real target every year
xassert(st.scenarios.crash.rows.every(function(r){ return Math.abs(r.withdraw - sbp.targetIncome) < 1; }), 'each bridge year draws the constant real target income');
// a higher minimum residual can only make things HARDER (monotonic in the floor)
const stFloor = Engine.bridgeStressTest(sbp, 50000);
xassert(!(stFloor.survivesNormal && !st.survivesNormal), 'raising the residual floor never turns a fail into a pass');
xassert(stFloor.survivesNormal === false, 'a £50k residual floor is not met by the full-depletion default (Normal now fails)');
// a very well-funded plan survives every stress scenario
const rich = JSON.parse(JSON.stringify(Engine.BRIDGE_DEFAULTS)); rich.currentBalance = 5000000;
const stRich = Engine.bridgeStressTest(rich, 0);
xassert(stRich.startAge === rich.currentAge, 'a huge starting pot is work-optional immediately');
xassert(stRich.survivesNormal && stRich.survivesBadStart, 'a richly funded bridge survives all three stress scenarios');
console.log(xfails === 0 ? 'ALL STRESS-TEST ASSERTIONS PASSED' : (xfails + ' STRESS-TEST ASSERTION(S) FAILED'));

// ===== Sequence-risk Phase 2 — historical bootstrap simulation =====
line();
console.log('SEQUENCE-RISK PHASE 2 (historical block-bootstrap)');
let pfails = 0; function passert(c,m){ if(!c){ console.log('FAIL:', m); pfails++; } }
const pbp = JSON.parse(JSON.stringify(Engine.BRIDGE_DEFAULTS));
// historical dataset sanity
passert(Engine.HIST_EQUITY_REAL.length === 97, 'historical series has 97 annual observations (1928–2024)');
passert(Engine.HIST_META.n === 97 && Engine.HIST_META.vol > 0.15 && Engine.HIST_META.vol < 0.25, 'historical vol ~19.6% real');
// block bootstrap draws only from the series and returns the requested length
const rng = (function(){ let a=1; return function(){ a=(a*16807)%2147483647; return a/2147483647; }; })();
const seq = Engine.blockBootstrap(Engine.HIST_EQUITY_REAL, 30, 5, rng);
passert(seq.length === 30, 'block bootstrap returns the requested length');
passert(seq.every(x => Engine.HIST_EQUITY_REAL.indexOf(x) >= 0), 'every bootstrapped return is an actual historical value');

const sim = Engine.bridgeSimulate(pbp);
console.log('Work-optional', sim.crossAgeExact, '| sim confidence @cross', (sim.confidenceAtCrossover*100).toFixed(1)+'%',
  '| stress-tested age (90%)', sim.stressAgeExact);
passert(sim.reached, 'default plan reaches a work-optional age to simulate');
passert(sim.confidenceAtCrossover > 0 && sim.confidenceAtCrossover < 1, 'crossover confidence is a genuine probability in (0,1)');
// deterministic (seeded): identical inputs -> identical result
passert(Engine.bridgeSimulate(pbp).confidenceAtCrossover === sim.confidenceAtCrossover, 'seeded simulation is deterministic');
// success rate is monotonic non-decreasing in the stop age
let mono = true, prev = -1;
for (let a = 48; a <= 57; a++){ const r = Engine.bridgeSurvivalRateAt(pbp, a, 0, {trials:2000, blockLen:5, seed:1234567}).rate; if (r < prev - 1e-9) mono = false; prev = r; }
passert(mono, 'survival rate is monotonic non-decreasing as the stop age rises');
passert(Engine.bridgeSurvivalRateAt(pbp, pbp.pensionAccessAge, 0, {trials:500,blockLen:5,seed:1234567}).rate === 1, 'stopping at pension access has no bridge to fund -> 100%');
// confidence ordering: a higher target confidence needs an equal-or-later age
const a80 = Engine.bridgeSimulate(pbp,{confidence:0.80}).stressAgeExact;
const a90 = Engine.bridgeSimulate(pbp,{confidence:0.90}).stressAgeExact;
const a95 = Engine.bridgeSimulate(pbp,{confidence:0.95}).stressAgeExact;
console.log('Stress-tested ages: 80% '+a80+' · 90% '+a90+' · 95% '+a95);
passert(a80 <= a90 && a90 <= a95, 'higher confidence => equal-or-later stress-tested age');
// crossover confidence below target => stress-tested age is later than the deterministic crossover
passert(sim.confidenceAtCrossover < 0.90 ? (a90 > sim.crossAgeExact) : true, 'if crossover confidence < target, the stress-tested age is later than the deterministic crossover');
// a bigger minimum-residual buffer can only lower (or hold) the success rate
const rLo = Engine.bridgeSurvivalRateAt(pbp, 52, 0, {trials:2000,blockLen:5,seed:1234567}).rate;
const rHi = Engine.bridgeSurvivalRateAt(pbp, 52, 100000, {trials:2000,blockLen:5,seed:1234567}).rate;
passert(rHi <= rLo, 'a higher residual buffer never increases the success rate');
// a richly funded plan is essentially certain and work-optional almost immediately
const prich = JSON.parse(JSON.stringify(Engine.BRIDGE_DEFAULTS)); prich.currentBalance = 5000000;
const simR = Engine.bridgeSimulate(prich, {confidence:0.95});
passert(simR.confidenceAtCrossover > 0.99, 'a richly funded bridge clears ~100% confidence');
console.log(pfails === 0 ? 'ALL PHASE-2 SIM ASSERTIONS PASSED' : (pfails + ' PHASE-2 SIM ASSERTION(S) FAILED'));

// ===== Sequence-risk — pension drawdown (Coast) =====
line();
console.log('SEQUENCE-RISK — PENSION DRAWDOWN (Coast)');
let dfails = 0; function dassert(c,m){ if(!c){ console.log('FAIL:', m); dfails++; } }
const dcp = JSON.parse(JSON.stringify(Engine.COAST_DEFAULTS));
const dst = Engine.coastStressTest(dcp, 0);
console.log('Retire', dst.startAge, '-> life', dst.accessAge, '('+dst.bridgeYears+'y draw) · pot', money(dst.startBalance), '· income', money(dst.income));
['normal','poorStart','crash'].forEach(k=>{const s=dst.scenarios[k];console.log('  '+k.padEnd(10)+' survived '+s.survived+'  residual '+money(s.residual)+(s.failAge!=null?'  dry @'+s.failAge:''));});
dassert(dst.startAge === Math.round(dcp.retirementAge), 'pension stress starts at the retirement age');
dassert(dst.accessAge === 90, 'drawdown horizon is life expectancy 90');
dassert(dst.bridgeYears === 90 - dst.startAge, 'draw years = life expectancy − retirement age');
dassert(dst.scenarios.normal.rows.length === dst.bridgeYears, 'one row per drawdown year');
// Normal drawdown-path residual reproduces a plain constant-return projection to the pound
(function(){
  var g = Engine.realReturn(dcp.growth, dcp.inflation), bal = dst.startBalance;
  for (var a = dst.startAge; a < 90; a++){ var sp = a >= 67 ? 11900 : 0; bal = Math.max(0, bal - Math.max(0, dst.income - sp)) * (1+g); }
  dassert(Math.abs(bal - dst.scenarios.normal.residual) < 1, 'Normal path reproduces the deterministic drawdown residual');
})();
dassert(dst.scenarios.crash.residual <= dst.scenarios.normal.residual, 'a crash never leaves more than the normal path');
const dsim = Engine.coastSimulate(dcp);
console.log('Confidence retiring @'+dst.startAge+':', (dsim.confidenceAtCrossover*100).toFixed(1)+'% · stress-tested retire age (90%):', dsim.stressAgeExact);
dassert(dsim.confidenceAtCrossover > 0 && dsim.confidenceAtCrossover <= 1, 'pension survival probability in (0,1]');
dassert(Engine.coastSimulate(dcp).confidenceAtCrossover === dsim.confidenceAtCrossover, 'seeded pension sim is deterministic');
// monotonic: retiring later (bigger pot, shorter draw) never lowers survival
let dmono = true, dprev = -1;
for (let a = 60; a <= 75; a++){ const r = Engine.coastSurvivalRateAt(dcp, a, 0, {trials:1500, blockLen:5, seed:1234567}).rate; if (r < dprev - 1e-9) dmono = false; dprev = r; }
dassert(dmono, 'pension survival is monotonic non-decreasing in the retirement age');
const dA = Engine.coastSimulate(dcp,{confidence:0.80}).stressAgeExact, dB = Engine.coastSimulate(dcp,{confidence:0.90}).stressAgeExact, dC = Engine.coastSimulate(dcp,{confidence:0.95}).stressAgeExact;
console.log('Stress-tested retire ages: 80% '+dA+' · 90% '+dB+' · 95% '+dC);
dassert(dA <= dB && dB <= dC, 'higher confidence => equal-or-later stress-tested retirement age');
console.log(dfails === 0 ? 'ALL PENSION-DRAWDOWN ASSERTIONS PASSED' : (dfails + ' PENSION-DRAWDOWN ASSERTION(S) FAILED'));

/* ============================================================
   9) MORTGAGE OVERPAYMENT vs INVESTING (side calculator)
   ============================================================ */
line();
console.log('MORTGAGE OVERPAYMENT vs INVESTING');
let mfails = 0; function massert(c,m){ if(!c){ console.log('FAIL:', m); mfails++; } }
const mbase = { growthFallback:0.07, lowGrowth:0.05, highGrowth:0.09 };
const MP = (patch) => Object.assign({}, Engine.MORTGAGE_DEFAULTS, mbase, patch||{});
const mr = Engine.mortgagePlan(MP({ horizonMode:'10' }));   // the 10-year slice
const mt = Engine.mortgagePlan(MP());                       // the default: full term
console.log('£200k · 4.5% · 20y · £2k/yr · 7% − 0.25% fee · 10-year horizon');
console.log('  payment           :', money(mr.payment), '/month');
console.log('  winner            :', mr.winner, 'by', money(Math.abs(mr.diff)));
console.log('  break-even return :', (mr.breakEven*100).toFixed(2)+'%');
console.log('  mortgage-free     :', mr.payoffMonths+'m -> '+mr.payoffMonthsOverpay+'m ('+mr.termCutMonths+'m earlier)');
console.log('  interest saved    :', money(mr.interestSaved), 'over 10y ·', money(mr.interestSavedLifetime), 'lifetime');
console.log('  sensitivity       :', mr.sensitivity.map(s=>(s.growth*100).toFixed(0)+'% '+s.winner+' '+money(Math.abs(s.diff))).join(' · '));

// the contractual payment is the standard amortisation of balance/rate/term
massert(Math.abs(mr.payment - Engine.mortgagePayment(200000, 0.045/12, 240)) < 0.01, 'payment = closed-form amortisation');
// with no overpayments the mortgage clears exactly at the end of the term
massert(mr.payoffMonths === 240, 'no-overpayment mortgage clears at the end of the term');
massert(mr.payoffMonthsOverpay < 240 && mr.termCutMonths === 240 - mr.payoffMonthsOverpay, 'overpaying clears earlier by termCutMonths');
massert(mr.interestSavedLifetime > mr.interestSaved && mr.interestSaved > 0, 'interest saved grows once you keep overpaying to the end');
massert(Engine.mortgageHorizonYears(MP()) === 20, 'the default comparison is the full remaining term');
massert(Math.abs(mt.interestSaved - mt.interestSavedLifetime) < 1, 'over the full term, interest saved IS the lifetime figure');
// net wealth = investments − debt, and both paths start at −balance
massert(mr.series[0].overpay === -200000 && mr.series[0].invest === -200000, 'both paths start at minus the mortgage');
massert(Math.abs(mr.overpay.net - (mr.overpay.investments - mr.overpay.balance)) < 0.02, 'overpay net wealth = investments − debt');
massert(Math.abs(mr.invest.net - (mr.invest.investments - mr.invest.balance)) < 0.02, 'invest net wealth = investments − debt');
massert(mr.series.length === 11 && mr.series[10].year === 10, 'one chart point a year over the horizon');
massert(mt.series.length === 21 && mt.series[20].year === 20, 'and over the full term');

// THE key consistency check: if investments compound at exactly the rate the
// mortgage charges, the two paths must be financially identical.
(function(){
  const equiv = Math.pow(1 + 0.045/12, 12) - 1;             // the mortgage's effective annual rate
  const flat = Engine.mortgagePlan(MP({ fee:0, taxDrag:0, overpayLimitPct:0, growth: equiv }));
  massert(Math.abs(flat.diff) < 1, 'at the mortgage rate exactly, overpaying and investing are level (diff ' + flat.diff + ')');
  massert(Math.abs(flat.breakEven - equiv) < 0.0005, 'break-even = the mortgage rate when there are no fees (' + (flat.breakEven*100).toFixed(3) + '% vs ' + (equiv*100).toFixed(3) + '%)');
  const fee = Engine.mortgagePlan(MP({ fee:0.0025, taxDrag:0, overpayLimitPct:0 }));
  massert(Math.abs(fee.breakEven - (equiv + 0.0025)) < 0.0006, 'a 0.25% fee lifts the break-even by ~0.25pp — the rate is not just parroted back');
})();

// more return is never worse for investing, and the model is linear in the spare cash
(function(){
  let prev = -Infinity, mono = true;
  for (let g = 0.02; g <= 0.12001; g += 0.01) {
    const d = Engine.mortgagePlan(MP({ growth:g, overpayLimitPct:0, horizonMode:'10' })).diff;
    if (d < prev - 1e-6) mono = false; prev = d;
  }
  massert(mono, 'investing’s advantage is monotonic in the assumed return');
  // linear only while neither path's structure changes — so hold the horizon
  // inside the mortgage term, where nothing has been paid off early yet
  const one = Engine.mortgagePlan(MP({ spare:2000, overpayLimitPct:0, horizonMode:'10' })).diff;
  const two = Engine.mortgagePlan(MP({ spare:4000, overpayLimitPct:0, horizonMode:'10' })).diff;
  massert(Math.abs(two - 2*one) < 1, 'twice the spare cash = twice the gap (no cap binding)');
  const s = Engine.mortgagePlan(MP()).sensitivity;
  massert(s[0].diff < s[1].diff && s[1].diff < s[2].diff, 'lower / central / higher returns order correctly');
})();

// the overpayment cap turns money away — and that money is invested, not lost
(function(){
  const capped = Engine.mortgagePlan(MP({ spare:1500, spareFreq:'monthly', horizonMode:'term' }));
  massert(capped.capBinding && capped.overpay.capped > 0, '£18k/yr against a 10% allowance hits the cap');
  massert(capped.overpay.investments > 0, 'cap overflow is invested rather than discarded');
  const free = Engine.mortgagePlan(MP({ spare:1500, spareFreq:'monthly', horizonMode:'term', overpayLimitPct:0 }));
  const cap5 = Engine.mortgagePlan(MP({ spare:1500, spareFreq:'monthly', horizonMode:'5' }));
  const free5 = Engine.mortgagePlan(MP({ spare:1500, spareFreq:'monthly', horizonMode:'5', overpayLimitPct:0 }));
  massert(free5.overpay.balance < cap5.overpay.balance, 'without a cap the same cash clears more debt');
  massert(free.payoffMonthsOverpay < capped.payoffMonthsOverpay, 'the cap delays the mortgage-free date');
})();

// once the overpaid mortgage is gone, the freed payment is invested (or overpaying
// would look bad purely because its money vanished from the comparison) — and
// BOTH paths stop committing spare cash at that same moment
(function(){
  const long = Engine.mortgagePlan(MP({ spare:1000, spareFreq:'monthly', horizonMode:'custom', horizonYears:25 }));
  massert(long.payoffMonthsOverpay < long.months, 'the overpaid mortgage clears inside this horizon');
  massert(long.overpay.investments > 0 && long.overpay.balance === 0, 'after payoff the overpay path holds investments, not debt');
  massert(Math.abs(long.spareCommitted - 1000*long.months) < 1, 'the spare keeps flowing to the end of the comparison, on both paths');
  massert(long.overpay.freedInvested > 0, 'the freed payment is invested on the overpaying path');
  massert(Math.abs(long.monthlyAfterPayoff - (long.payment + 1000)) < 0.01, 'after payoff it invests the payment plus the spare');
})();

// the two paths always commit the SAME spare cash, and the two gains always
// reconcile with the headline gap (cash conservation)
(function(){
  [{}, {horizonMode:'term'}, {spare:1500,spareFreq:'monthly',horizonMode:'term'},
   {spare:500,spareFreq:'monthly',horizonMode:'5'}, {rate:0.08,horizonMode:'term'},
   {rateChangeTo:0.07,rateChangeAfterYears:3,horizonMode:'term'}].forEach(function(patch,i){
    const r = Engine.mortgagePlan(MP(patch));
    massert(Math.abs((r.investGain - r.overpayGain) - r.diff) < 0.05, 'case '+i+': growth − interest saved = the net-wealth gap');
    massert(Math.abs(r.overpay.extra + r.overpay.capped + (r.spareCommitted - r.overpay.extra - r.overpay.capped)) - r.spareCommitted < 0.05, 'case '+i+': spare cash is fully accounted for');
    massert(r.series[0].saved === 0 && r.series[0].growth === 0, 'case '+i+': both chart lines start at zero');
  });
})();

// a future rate rise makes overpaying more valuable -> a higher break-even
(function(){
  const flat2 = Engine.mortgagePlan(MP({ horizonMode:'term' }));
  const rise  = Engine.mortgagePlan(MP({ horizonMode:'term', rateChangeTo:0.07, rateChangeAfterYears:3 }));
  massert(rise.breakEven > flat2.breakEven, 'modelling a rate rise raises the return investing must beat');
})();

// guards: the module asks for what it needs rather than computing nonsense
massert(!Engine.mortgagePlan(MP({ balance:0 })).ready, 'no balance -> not ready');
massert(!Engine.mortgagePlan(MP({ termYears:0 })).ready, 'no term -> not ready');
massert(!Engine.mortgagePlan(MP({ spare:0 })).ready && Engine.mortgagePlan(MP({ spare:0 })).breakEven === null, 'no spare cash -> not ready, no break-even');
// a payment that doesn't even cover the interest falls back to the contractual one
massert(Engine.mortgagePlan(MP({ payment:100 })).paymentTooLow, 'a payment below the interest is flagged');
massert(Math.abs(Engine.mortgagePlan(MP({ payment:100 })).payment - mr.payment) < 0.01, '...and the contractual payment is used instead');
// horizon resolution
massert(Engine.mortgageHorizonYears(MP({horizonMode:'term'})) === 20, 'horizon "term" = the remaining term');
massert(Engine.mortgageHorizonYears(MP({horizonMode:'custom', horizonYears:7})) === 7, 'custom horizon honoured');
console.log(mfails === 0 ? 'ALL MORTGAGE ASSERTIONS PASSED' : (mfails + ' MORTGAGE ASSERTION(S) FAILED'));
