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
const bp = JSON.parse(JSON.stringify(Engine.BRIDGE_DEFAULTS));
const plan = Engine.bridgePlan(bp);
console.log('Target pot        :', money(plan.targetPot));
console.log('Crossover age     :', plan.base.crossAge, '(expected 46)');
console.log('Balance @ cross   :', money(plan.base.crossBalance));
console.log('Income @ cross    :', money(plan.base.incomeAtCross)+'/yr');
console.log('Balance @ access  :', money(plan.base.balanceAtAccess));
console.log('Conservative/Optimistic cross:', plan.conservative.crossAge, '/', plan.optimistic.crossAge);
let bfails = 0;
function bassert(c,m){ if(!c){ console.log('FAIL:', m); bfails++; } }
bassert(plan.base.crossAge === 46, 'worked example reaches optionality at age 46');
bassert(Math.abs(plan.targetPot - 1600000) < 1, 'target pot = £1.6m at £80k / 5%');
bassert(plan.conservative.crossAge > plan.base.crossAge, 'conservative is later than base');
bassert(plan.optimistic.crossAge < plan.base.crossAge, 'optimistic is earlier than base');
const bpFull = Object.assign({}, JSON.parse(JSON.stringify(bp)), { mode:'bridge', bridgeDepletion:'full' });
bassert(Engine.bridgePlan(bpFull).base.crossAge < 46, 'bridge full-depletion is earlier than perpetual');
const bpPres = Object.assign({}, JSON.parse(JSON.stringify(bp)), { mode:'bridge', bridgeDepletion:'preserve' });
bassert(Engine.bridgePlan(bpPres).base.crossAge === 46, 'bridge preserve-capital equals perpetual');
console.log(bfails === 0 ? 'ALL BRIDGE ASSERTIONS PASSED' : (bfails + ' BRIDGE ASSERTION(S) FAILED'));

// ===== Pension Coast FIRE Planner =====
line();
console.log('COAST PLANNER — worked example');
const cp = JSON.parse(JSON.stringify(Engine.COAST_DEFAULTS));
const cplan = Engine.coastPlan(cp);
console.log('Coast age         :', cplan.base.coastAge, '(expected 40)');
console.log('Coast balance     :', money(cplan.base.coastBalance));
console.log('Target pot        :', money(cplan.targetPot), 'at', cplan.objAge);
console.log('Pot @ objective   :', money(cplan.base.potAtObj));
let cfails = 0;
function cassert(c,m){ if(!c){ console.log('FAIL:', m); cfails++; } }
cassert(cplan.base.coastAge === 40, 'worked example coasts at age 40');
cassert(Math.abs(cplan.base.coastBalance - 775000) < 2000, 'coast balance ≈ £775k');
cassert(cplan.targetPot === 3000000, 'pot-mode target = £3m');
const cInc = Object.assign({}, JSON.parse(JSON.stringify(cp)), { goalMode:'income' });
cassert(Math.abs(Engine.coastPlan(cInc).targetPot - 2000000) < 1, 'income mode £80k / 4% = £2m required');
cassert(cplan.stopSchedule.find(s=>s.stopAge===40).meetsTarget, 'contributing to 40 meets the target');
cassert(!cplan.stopSchedule.find(s=>s.stopAge===39).meetsTarget, 'stopping at 39 misses the target');
cassert(cplan.optimistic.coastAge < cplan.base.coastAge, 'optimistic coasts earlier than base');
console.log(cfails === 0 ? 'ALL COAST ASSERTIONS PASSED' : (cfails + ' COAST ASSERTION(S) FAILED'));

// bridge drawdown option leaves the crossover age unchanged, changes later pot
const bpd = Object.assign({}, JSON.parse(JSON.stringify(Engine.BRIDGE_DEFAULTS)), { drawdownFromOptionality:true });
const bBase = Engine.bridgePlan(JSON.parse(JSON.stringify(Engine.BRIDGE_DEFAULTS))).base;
const bDraw = Engine.bridgePlan(bpd).base;
console.log('Bridge drawdown: crossover', bDraw.crossAge, '(unchanged '+ (bDraw.crossAge===bBase.crossAge) +') · balance@access', money(bDraw.balanceAtAccess), 'vs', money(bBase.balanceAtAccess), 'without');
