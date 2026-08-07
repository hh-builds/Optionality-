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
cassert(realOf(0.07,0.03) < realOf(scDef.growth, scDef.inflation), 'conservative real return is below base');
cassert(realOf(0.11,0.02) > realOf(scDef.growth, scDef.inflation), 'optimistic real return is above base');
cassert(scPlan.conservative.coastAge == null || scPlan.base.coastAge == null || scPlan.conservative.coastAge >= scPlan.base.coastAge, 'conservative coasts no earlier than base');
cassert(scPlan.optimistic.coastAge == null || (scPlan.base.coastAge != null && scPlan.optimistic.coastAge <= scPlan.base.coastAge), 'optimistic coasts no later than base');
console.log('Scenario coast ages (defaults): base', scPlan.base.coastAge, '· conservative', scPlan.conservative.coastAge, '· optimistic', scPlan.optimistic.coastAge);
console.log(cfails === 0 ? 'ALL COAST ASSERTIONS PASSED' : (cfails + ' COAST ASSERTION(S) FAILED'));

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
