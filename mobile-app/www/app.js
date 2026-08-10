const { useState, useMemo, useEffect, useRef } = React;
const R = window.Recharts || {};
const {
  ResponsiveContainer,
  LineChart,
  Line,
  AreaChart,
  Area,
  ComposedChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  Cell
} = R;
const gbp = (x, dp) => {
  if (x == null || isNaN(x)) return "\u2014";
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    minimumFractionDigits: dp || 0,
    maximumFractionDigits: dp || 0
  }).format(x);
};
const gbpC = (x) => {
  if (x == null || isNaN(x)) return "\u2014";
  const a = Math.abs(x);
  if (a >= 1e6) return "\xA3" + (x / 1e6).toFixed(2).replace(/\.00$/, "") + "M";
  if (a >= 1e3) return "\xA3" + Math.round(x / 1e3) + "k";
  return "\xA3" + Math.round(x);
};
const ageStr = (a) => a == null ? "\u2014" : a.toFixed(1);
const monthsStr = (m) => {
  const s = Math.round(Math.abs(m));
  const y = Math.floor(s / 12);
  const mo = s % 12;
  if (y === 0) return mo + " month" + (mo === 1 ? "" : "s");
  if (mo === 0) return y + " year" + (y === 1 ? "" : "s");
  return y + "y " + mo + "m";
};
function useColors() {
  const read = () => {
    const cs = getComputedStyle(document.documentElement);
    const g = (n) => cs.getPropertyValue(n).trim();
    return {
      pension: g("--series-pension"),
      isa: g("--series-isa"),
      gia: g("--series-gia"),
      cash: g("--series-cash"),
      home: g("--series-home"),
      red: g("--series-red"),
      grid: g("--grid"),
      axis: g("--muted"),
      baseline: g("--baseline"),
      good: g("--good"),
      text: g("--text-secondary")
    };
  };
  const [c, setC] = useState(read);
  useEffect(() => {
    const obs = new MutationObserver(() => setC(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  return c;
}
function useIsNarrow(px) {
  const q = "(max-width:" + (px || 560) + "px)";
  const get = () => typeof window !== "undefined" && window.matchMedia ? window.matchMedia(q).matches : false;
  const [narrow, setNarrow] = useState(get);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(q);
    const h = () => setNarrow(mq.matches);
    h();
    mq.addEventListener ? mq.addEventListener("change", h) : mq.addListener(h);
    return () => {
      mq.removeEventListener ? mq.removeEventListener("change", h) : mq.removeListener(h);
    };
  }, [q]);
  return narrow;
}
function NumInput({ value, onChange, step, min, className, style, title, ariaLabel }) {
  const [txt, setTxt] = useState(value == null ? "" : String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setTxt(value == null ? "" : String(value));
  }, [value]);
  const handle = (raw) => {
    setTxt(raw);
    if (raw === "" || raw === "-" || raw === ".") {
      onChange(0);
      return;
    }
    const n = parseFloat(raw);
    if (!isNaN(n)) onChange(n);
  };
  return /* @__PURE__ */ React.createElement(
    "input",
    {
      type: "number",
      className,
      style,
      step: step || "any",
      min,
      title,
      "aria-label": ariaLabel,
      value: txt,
      inputMode: "decimal",
      onFocus: (e) => {
        focused.current = true;
        e.target.select();
      },
      onBlur: () => {
        focused.current = false;
        let n = parseFloat(txt);
        if (isNaN(n)) n = 0;
        if (min != null) n = Math.max(min, n);
        setTxt(String(n));
        onChange(n);
      },
      onChange: (e) => handle(e.target.value)
    }
  );
}
function ChartTip({ active, payload, label, fmt }) {
  if (!active || !payload || !payload.length) return null;
  return /* @__PURE__ */ React.createElement("div", { className: "tooltip" }, /* @__PURE__ */ React.createElement("div", { className: "t-age" }, "Age ", label), payload.filter((p) => p.value != null).map((p, i) => /* @__PURE__ */ React.createElement("div", { className: "t-row", key: i }, /* @__PURE__ */ React.createElement("span", { className: "nm" }, /* @__PURE__ */ React.createElement("span", { className: "sw", style: { background: p.color || p.stroke } }), p.name), /* @__PURE__ */ React.createElement("span", { className: "amt" }, (fmt || gbpC)(p.value)))));
}
function BpNum({ value, onChange, step, min, money, pct, suffix }) {
  return /* @__PURE__ */ React.createElement("div", { className: "bp-inwrap" + (money ? " money" : "") + (pct ? " pct" : "") }, money && /* @__PURE__ */ React.createElement("span", { className: "pfx" }, "\xA3"), /* @__PURE__ */ React.createElement(NumInput, { value, onChange, step, min: min != null ? min : 0 }), pct && /* @__PURE__ */ React.createElement("span", { className: "sfx" }, "%"), suffix && !pct && /* @__PURE__ */ React.createElement("span", { className: "sfx" }, suffix));
}
function BridgePlanner({ bp, setBp, plan, C, realTerms, setRealTerms }) {
  const base = plan.base, cons = plan.conservative, opt = plan.optimistic;
  const narrow = useIsNarrow();
  const bf = (age) => realTerms ? 1 : Math.pow(1 + (bp.inflation || 0), (age || bp.currentAge) - bp.currentAge);
  const m = (v, age) => gbpC(v * bf(age));
  const scEnabled = {
    conservative: !!(bp.scenarios && bp.scenarios.conservative && bp.scenarios.conservative.enabled),
    optimistic: !!(bp.scenarios && bp.scenarios.optimistic && bp.scenarios.optimistic.enabled)
  };
  const data = base.rows.map((r, i) => {
    const o = { age: r.age, target: r.target * bf(r.age), balance: r.balance * bf(r.age) };
    if (scEnabled.conservative && cons.rows[i]) o.cons = cons.rows[i].balance * bf(r.age);
    if (scEnabled.optimistic && opt.rows[i]) o.opt = opt.rows[i].balance * bf(r.age);
    return o;
  });
  const updScen = (key, patch) => setBp({ scenarios: Object.assign({}, bp.scenarios, { [key]: Object.assign({}, (bp.scenarios || {})[key], patch) }) });
  const updPhase = (i, patch) => setBp({ phases: bp.phases.map((p, idx) => idx === i ? Object.assign({}, p, patch) : p) });
  const addPhase = () => {
    const last = bp.phases[bp.phases.length - 1];
    const from = last ? (last.toAge || bp.currentAge) + 1 : bp.currentAge;
    setBp({ phases: bp.phases.concat([{ fromAge: from, toAge: Math.max(from, bp.pensionAccessAge), annual: 0 }]) });
  };
  const delPhase = (i) => {
    if (bp.phases.length <= 1) return;
    setBp({ phases: bp.phases.filter((_, idx) => idx !== i) });
  };
  const reached = base.reached;
  const targetPot = plan.targetPot;
  const surplusGood = base.surplusAtCross != null && base.surplusAtCross >= 0;
  const rowClass = (r) => {
    const ratio = r.target > 0 ? r.balance / r.target : r.balance >= 0 ? 2 : 0;
    if (ratio >= 1) return "bp-green";
    if (ratio >= 0.9) return "bp-amber";
    return "bp-below";
  };
  const rowStatus = (r) => {
    const ratio = r.target > 0 ? r.balance / r.target : r.balance >= 0 ? 2 : 0;
    if (ratio >= 1) return ["green", "Reached"];
    if (ratio >= 0.9) return ["amber", "Close"];
    return ["below", "Below"];
  };
  const ScenChip = ({ name, label, color, res, toggleable }) => /* @__PURE__ */ React.createElement(
    "button",
    {
      className: "bp-chip" + (toggleable && !scEnabled[name] ? " off" : ""),
      onClick: () => toggleable ? updScen(name, { enabled: !scEnabled[name] }) : null,
      title: toggleable ? "Show / hide this scenario on the chart" : "The primary scenario \u2014 drives the headline and table"
    },
    /* @__PURE__ */ React.createElement("span", { className: "cd", style: { background: color } }),
    label,
    /* @__PURE__ */ React.createElement("span", { className: "cage" }, res.crossAge != null ? "age " + res.crossAge : "not by " + bp.pensionAccessAge)
  );
  return /* @__PURE__ */ React.createElement("div", { className: "bridge-planner" }, /* @__PURE__ */ React.createElement("div", { className: "bp-topline" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "bp-q" }, "Accessible wealth \xB7 bridge planner"), /* @__PURE__ */ React.createElement("div", { className: "bp-title" }, /* @__PURE__ */ React.createElement("span", { className: "bp-star" }, "\u2B50"), " When does my accessible wealth give me full optionality?")), /* @__PURE__ */ React.createElement("div", { className: "bp-terms" }, /* @__PURE__ */ React.createElement("div", { className: "bp-seg", role: "group", "aria-label": "value basis" }, /* @__PURE__ */ React.createElement("button", { className: realTerms ? "on" : "", onClick: () => setRealTerms(true) }, "Today\u2019s money"), /* @__PURE__ */ React.createElement("button", { className: !realTerms ? "on" : "", onClick: () => setRealTerms(false) }, "Nominal")))), /* @__PURE__ */ React.createElement("div", { className: "bp-headline" }, /* @__PURE__ */ React.createElement("div", { className: "bp-big " + (reached ? "reached" : "missed") }, reached ? "Age " + (base.crossAgeExact != null ? base.crossAgeExact.toFixed(1) : base.crossAge) : "Not by " + bp.pensionAccessAge), /* @__PURE__ */ React.createElement("div", { className: "bp-cap" }, reached ? bp.mode === "bridge" ? "Work-optional at age " + (base.crossAgeExact != null ? base.crossAgeExact.toFixed(1) : base.crossAge) + " \u2014 your " + gbpC(base.crossBalance * bf(base.crossAge)) + " accessible pot can fund " + gbpC(bp.targetIncome * bf(base.crossAge)) + "/yr from then until pension access " + bp.pensionAccessAge + " (drawing down as you go), when your pension takes over." : "Full optionality \u2014 your projected ISA/GIA first covers the " + gbpC(targetPot * bf(base.crossAge)) + " portfolio needed to support " + gbpC(bp.targetIncome * bf(base.crossAge)) + "/yr indefinitely at a " + (bp.withdrawalRate * 100).toFixed(1) + "% withdrawal rate." : "On these assumptions your accessible wealth doesn\u2019t yet reach the pot needed to fund " + gbpC(bp.targetIncome) + "/yr by pension access age " + bp.pensionAccessAge + ". Adjust contributions, growth or the target below."), base.reached && bp.drawdownFromOptionality && (function() {
    var lasts = base.depletionAge == null || base.depletionAge >= bp.pensionAccessAge;
    var covers = (base.depletionAge != null ? base.depletionAge : bp.lifeExpectancy || 90) - base.crossAge;
    return /* @__PURE__ */ React.createElement("div", { className: "bp-verdict " + (lasts ? "ok" : "bad") }, lasts ? /* @__PURE__ */ React.createElement("span", null, "\u2705 ", /* @__PURE__ */ React.createElement("b", null, "Your bridge lasts to pension access ", bp.pensionAccessAge, "."), base.depletionAge ? " On accessible wealth alone it would then run dry at age " + base.depletionAge + "." : "") : /* @__PURE__ */ React.createElement("span", null, "\u274C ", /* @__PURE__ */ React.createElement("b", null, "Bridge runs dry at age ", base.depletionAge), " \u2014 ", bp.pensionAccessAge - base.depletionAge, " year", bp.pensionAccessAge - base.depletionAge === 1 ? "" : "s", " short of pension access ", bp.pensionAccessAge, "."), /* @__PURE__ */ React.createElement("span", { className: "bp-verdict-sub" }, " Covers ", covers, " year", covers === 1 ? "" : "s", " of withdrawals from age ", base.crossAge, "."));
  })()), /* @__PURE__ */ React.createElement("details", { className: "bp-why" }, /* @__PURE__ */ React.createElement("summary", null, "Why does the bridge last to ", bp.pensionAccessAge, " but can run out later?"), /* @__PURE__ */ React.createElement("ol", null, /* @__PURE__ */ React.createElement("li", null, "The bridge fund only has to cover the years ", /* @__PURE__ */ React.createElement("b", null, "between stopping work and pension access (", bp.pensionAccessAge, ")"), " \u2014 from ", bp.pensionAccessAge, " your pension can take over the income."), /* @__PURE__ */ React.createElement("li", null, "The chart keeps drawing from your ISA/GIA ", /* @__PURE__ */ React.createElement("b", null, "past ", bp.pensionAccessAge), " to stress-test it alone, so it can show the accessible pot emptying later", base.depletionAge ? /* @__PURE__ */ React.createElement("span", null, " (age ", base.depletionAge, ")") : "", " \u2014 but in reality your pension covers you from ", bp.pensionAccessAge, ', so that "run-out" is just the bridge on its own.'), /* @__PURE__ */ React.createElement("li", null, "These figures are ", /* @__PURE__ */ React.createElement("b", null, "live from your inputs"), " \u2014 right now that's ", (bp.growth * 100).toFixed(1), "% nominal return \u2212 ", ((bp.inflation || 0) * 100).toFixed(1), "% inflation \u2248 ", /* @__PURE__ */ React.createElement("b", null, (((1 + bp.growth) / (1 + (bp.inflation || 0)) - 1) * 100).toFixed(1), "% real growth"), ". Change the return, inflation, contributions, target or ages above and every age, balance and the chart recompute instantly. The Today's money / Nominal toggle only relabels the units \u2014 it doesn't change the plan."))), /* @__PURE__ */ React.createElement("div", { className: "bp-scen-chips" }, /* @__PURE__ */ React.createElement(ScenChip, { name: "base", label: "Base", color: C.pension, res: base, toggleable: false }), /* @__PURE__ */ React.createElement(ScenChip, { name: "conservative", label: "Conservative", color: C.gia, res: cons, toggleable: true }), /* @__PURE__ */ React.createElement(ScenChip, { name: "optimistic", label: "Optimistic", color: C.isa, res: opt, toggleable: true })), /* @__PURE__ */ React.createElement("div", { className: "bp-basis " + (realTerms ? "real" : "nom") }, realTerms ? /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("b", null, "Today\u2019s money (real)."), " Every figure is deflated by inflation into today\u2019s purchasing power. Your return is nominal, so higher inflation means less real growth \u2014 raising inflation makes these figures worse.") : /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("b", null, "Nominal (future \xA3)."), " The actual pounds of each future year, projected at your nominal return. Not adjusted for inflation, so they look bigger than their real worth.")), /* @__PURE__ */ React.createElement("div", { className: "bp-results" }, /* @__PURE__ */ React.createElement("div", { className: "bp-tile" }, /* @__PURE__ */ React.createElement("div", { className: "bt-k" }, "Years to optionality"), /* @__PURE__ */ React.createElement("div", { className: "bt-v" }, base.yearsUntil != null ? base.yearsUntil + (base.yearsUntil === 1 ? " yr" : " yrs") : "\u2014")), /* @__PURE__ */ React.createElement("div", { className: "bp-tile" }, /* @__PURE__ */ React.createElement("div", { className: "bt-k" }, "Balance at crossover"), /* @__PURE__ */ React.createElement("div", { className: "bt-v" }, base.crossBalance != null ? m(base.crossBalance, base.crossAge) : "\u2014")), /* @__PURE__ */ React.createElement("div", { className: "bp-tile" }, /* @__PURE__ */ React.createElement("div", { className: "bt-k" }, bp.mode === "bridge" ? "Income funded" : "Income supported", " \xB7 today\u2019s \xA3"), /* @__PURE__ */ React.createElement("div", { className: "bt-v" }, bp.mode === "bridge" ? reached ? gbpC(bp.targetIncome) + "/yr" : "\u2014" : base.incomeAtCross != null ? gbpC(base.incomeAtCross) + "/yr" : "\u2014")), /* @__PURE__ */ React.createElement("div", { className: "bp-tile" }, /* @__PURE__ */ React.createElement("div", { className: "bt-k" }, "Surplus vs target"), /* @__PURE__ */ React.createElement("div", { className: "bt-v " + (base.surplusAtCross != null ? surplusGood ? "pos" : "neg" : "") }, base.surplusAtCross != null ? (surplusGood ? "+" : "\u2212") + m(Math.abs(base.surplusAtCross), base.crossAge) : "\u2014")), /* @__PURE__ */ React.createElement("div", { className: "bp-tile" }, /* @__PURE__ */ React.createElement("div", { className: "bt-k" }, "Balance @ access ", bp.pensionAccessAge), /* @__PURE__ */ React.createElement("div", { className: "bt-v" }, base.balanceAtAccess != null ? m(base.balanceAtAccess, bp.pensionAccessAge) : "\u2014"))), /* @__PURE__ */ React.createElement("div", { className: "bp-chart" }, ResponsiveContainer ? /* @__PURE__ */ React.createElement(ResponsiveContainer, { width: "100%", height: narrow ? 236 : 320 }, /* @__PURE__ */ React.createElement(LineChart, { data, margin: { top: 24, right: 18, left: 8, bottom: 2 } }, /* @__PURE__ */ React.createElement(CartesianGrid, { stroke: C.grid, vertical: false }), /* @__PURE__ */ React.createElement(XAxis, { dataKey: "age", stroke: C.axis, tick: { fontSize: narrow ? 10 : 11, fill: C.axis }, tickLine: false, axisLine: { stroke: C.baseline }, padding: { left: 4, right: 8 }, minTickGap: narrow ? 26 : 8, interval: "preserveStartEnd" }), /* @__PURE__ */ React.createElement(YAxis, { stroke: C.axis, tick: { fontSize: 11, fill: C.axis }, tickLine: false, axisLine: false, tickFormatter: gbpC, width: 52 }), /* @__PURE__ */ React.createElement(Tooltip, { content: /* @__PURE__ */ React.createElement(ChartTip, null) }), reached && /* @__PURE__ */ React.createElement(
    ReferenceLine,
    {
      x: base.crossAge,
      stroke: C.good,
      strokeDasharray: "4 3",
      strokeWidth: 1.5,
      label: { value: (narrow ? "Opt " : "Optionality ") + base.crossAge, position: "insideTopRight", fill: C.good, fontSize: 11, fontWeight: 700 }
    }
  ), /* @__PURE__ */ React.createElement(ReferenceLine, { x: bp.pensionAccessAge, stroke: C.axis, strokeDasharray: "3 3", label: { value: (narrow ? "Access " : "Pension access ") + bp.pensionAccessAge, position: "insideTop", fill: C.axis, fontSize: 10 } }), base.depletionAge && /* @__PURE__ */ React.createElement(ReferenceLine, { x: base.depletionAge, stroke: C.red, strokeWidth: 1.5, label: { value: (narrow ? "Out " : "Runs out ") + base.depletionAge, position: "insideTopRight", fill: C.red, fontSize: 11, fontWeight: 700 } }), /* @__PURE__ */ React.createElement(Line, { type: "monotone", dataKey: "target", name: "Target portfolio", stroke: C.red, strokeWidth: 2, dot: false, strokeDasharray: "5 4" }), scEnabled.conservative && /* @__PURE__ */ React.createElement(Line, { type: "monotone", dataKey: "cons", name: "Conservative", stroke: C.gia, strokeWidth: 1.6, dot: false }), scEnabled.optimistic && /* @__PURE__ */ React.createElement(Line, { type: "monotone", dataKey: "opt", name: "Optimistic", stroke: C.isa, strokeWidth: 1.6, dot: false }), /* @__PURE__ */ React.createElement(Line, { type: "monotone", dataKey: "balance", name: "Projected ISA/GIA", stroke: C.pension, strokeWidth: 2.6, dot: false }))) : /* @__PURE__ */ React.createElement("div", { className: "muted" }, "Chart library unavailable."), /* @__PURE__ */ React.createElement("div", { className: "legend-row", style: { marginBottom: 2 } }, /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("span", { className: "sw", style: { background: C.pension } }), "Projected ISA/GIA (Base)"), /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("span", { className: "sw", style: { background: C.red } }), "Target portfolio"), scEnabled.conservative && /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("span", { className: "sw", style: { background: C.gia } }), "Conservative"), scEnabled.optimistic && /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("span", { className: "sw", style: { background: C.isa } }), "Optimistic"), /* @__PURE__ */ React.createElement("span", { className: "terms-tag" }, realTerms ? "today\u2019s money" : "future \xA3 (nominal)"))), /* @__PURE__ */ React.createElement("div", { className: "bp-sub" }, "How your target works"), /* @__PURE__ */ React.createElement("div", { className: "bp-toggles" }, /* @__PURE__ */ React.createElement("div", { className: "bp-tgroup" }, /* @__PURE__ */ React.createElement("span", { className: "tl" }, "Model"), /* @__PURE__ */ React.createElement("div", { className: "bp-seg" }, /* @__PURE__ */ React.createElement("button", { className: bp.mode === "perpetual" ? "on" : "", onClick: () => setBp({ mode: "perpetual" }), title: "Target = a perpetual pot (income \xF7 withdrawal rate) you never run down" }, "Perpetual portfolio"), /* @__PURE__ */ React.createElement("button", { className: bp.mode === "bridge" ? "on" : "", onClick: () => setBp({ mode: "bridge" }), title: "Target = only the pot needed to bridge to pension access \u2014 falls as access nears" }, "Bridge to pension access"))), bp.mode === "bridge" && /* @__PURE__ */ React.createElement("div", { className: "bp-tgroup" }, /* @__PURE__ */ React.createElement("span", { className: "tl" }, "By pension access, I\u2019m comfortable\u2026"), /* @__PURE__ */ React.createElement("div", { className: "bp-seg" }, /* @__PURE__ */ React.createElement("button", { className: bp.bridgeDepletion === "preserve" ? "on" : "", onClick: () => setBp({ bridgeDepletion: "preserve" }) }, "Preserving capital"), /* @__PURE__ */ React.createElement("button", { className: bp.bridgeDepletion === "partial" ? "on" : "", onClick: () => setBp({ bridgeDepletion: "partial" }) }, "Partially depleting"), /* @__PURE__ */ React.createElement("button", { className: bp.bridgeDepletion === "full" ? "on" : "", onClick: () => setBp({ bridgeDepletion: "full" }) }, "Fully using the bridge"))), bp.mode === "bridge" && bp.bridgeDepletion === "partial" && /* @__PURE__ */ React.createElement("div", { className: "bp-tgroup" }, /* @__PURE__ */ React.createElement("span", { className: "tl" }, "Capital left at access"), /* @__PURE__ */ React.createElement(BpNum, { pct: true, value: +((bp.partialRemainPct != null ? bp.partialRemainPct : 0.5) * 100).toFixed(0), step: "5", onChange: (v) => setBp({ partialRemainPct: (v || 0) / 100 }) }))), /* @__PURE__ */ React.createElement("div", { className: "bp-note", style: { marginBottom: 14 } }, bp.mode === "perpetual" ? "Perpetual: target = income \xF7 withdrawal rate = " + gbpC(bp.targetIncome) + " \xF7 " + (bp.withdrawalRate * 100).toFixed(1) + "% = " + gbpC(targetPot) + " \u2014 a pot you could live off indefinitely (a 4\u20135% rule)." : "Bridge: the accessible pot only needs to last until pension access " + bp.pensionAccessAge + ", so the target is smaller and shrinks each year. " + (bp.bridgeDepletion === "preserve" ? "Preserving capital keeps the full " + gbpC(targetPot) + " perpetual pot intact at access." : bp.bridgeDepletion === "full" ? "Fully using it draws the pot to zero by access \u2014 the withdrawal rate isn\u2019t used here." : "Partially depleting leaves " + Math.round((bp.partialRemainPct != null ? bp.partialRemainPct : 0.5) * 100) + "% of the perpetual pot at access.")), /* @__PURE__ */ React.createElement("div", { className: "bp-sub" }, "Key assumptions"), /* @__PURE__ */ React.createElement("div", { className: "bp-assump" }, /* @__PURE__ */ React.createElement("div", { className: "bp-fld" }, /* @__PURE__ */ React.createElement("label", null, "Current age"), /* @__PURE__ */ React.createElement(BpNum, { value: bp.currentAge, step: "0.1", onChange: (v) => setBp({ currentAge: Math.round(v * 10) / 10 }) })), /* @__PURE__ */ React.createElement("div", { className: "bp-fld" }, /* @__PURE__ */ React.createElement("label", null, "Current ISA / GIA"), /* @__PURE__ */ React.createElement(BpNum, { money: true, value: bp.currentBalance, step: 1e3, onChange: (v) => setBp({ currentBalance: v }) })), /* @__PURE__ */ React.createElement("div", { className: "bp-fld" }, /* @__PURE__ */ React.createElement("label", null, "Target income / yr (today\u2019s money)"), /* @__PURE__ */ React.createElement(BpNum, { money: true, value: bp.targetIncome, step: 1e3, onChange: (v) => setBp({ targetIncome: v }) })), !(bp.mode === "bridge" && bp.bridgeDepletion === "full") && /* @__PURE__ */ React.createElement("div", { className: "bp-fld" }, /* @__PURE__ */ React.createElement("label", null, "Withdrawal rate"), /* @__PURE__ */ React.createElement(BpNum, { pct: true, value: +(bp.withdrawalRate * 100).toFixed(2), step: "0.1", onChange: (v) => setBp({ withdrawalRate: (v || 0) / 100 }) })), /* @__PURE__ */ React.createElement("div", { className: "bp-fld" }, /* @__PURE__ */ React.createElement("label", null, "Expected annual return (nominal)"), /* @__PURE__ */ React.createElement(BpNum, { pct: true, value: +(bp.growth * 100).toFixed(2), step: "0.1", onChange: (v) => setBp({ growth: (v || 0) / 100 }) })), /* @__PURE__ */ React.createElement("div", { className: "bp-fld" }, /* @__PURE__ */ React.createElement("label", null, "Inflation"), /* @__PURE__ */ React.createElement(BpNum, { pct: true, value: +((bp.inflation || 0) * 100).toFixed(2), step: "0.1", onChange: (v) => setBp({ inflation: (v || 0) / 100 }) })), /* @__PURE__ */ React.createElement("div", { className: "bp-fld" }, /* @__PURE__ */ React.createElement("label", null, "Pension access age"), /* @__PURE__ */ React.createElement(BpNum, { value: bp.pensionAccessAge, onChange: (v) => setBp({ pensionAccessAge: Math.round(v) }) }))), /* @__PURE__ */ React.createElement("div", { className: "bp-note" }, "Growth is your ", /* @__PURE__ */ React.createElement("b", null, "nominal"), " return; the engine nets off inflation to get the real return that drives the projection, so raising inflation pushes the crossover age ", /* @__PURE__ */ React.createElement("b", null, "later"), ". Withdrawals rise with inflation; contributions stay as entered. Lump sums (e.g. an earn-out) go in as a one-off phase below."), /* @__PURE__ */ React.createElement("div", { className: "bp-sub" }, "Contribution phases"), /* @__PURE__ */ React.createElement("div", { className: "bp-phases" }, /* @__PURE__ */ React.createElement("div", { className: "bp-phase-head" }, /* @__PURE__ */ React.createElement("span", null, "From age"), /* @__PURE__ */ React.createElement("span", null, "To age"), /* @__PURE__ */ React.createElement("span", null, "Annual contribution"), /* @__PURE__ */ React.createElement("span", null)), bp.phases.map((p, i) => {
    const yrs = p.toAge >= p.fromAge ? p.toAge - p.fromAge + 1 : 0;
    return /* @__PURE__ */ React.createElement(React.Fragment, { key: i }, /* @__PURE__ */ React.createElement("div", { className: "bp-phase" }, /* @__PURE__ */ React.createElement(BpNum, { value: p.fromAge, onChange: (v) => updPhase(i, { fromAge: Math.round(v) }) }), /* @__PURE__ */ React.createElement(BpNum, { value: p.toAge, onChange: (v) => updPhase(i, { toAge: Math.round(v) }) }), /* @__PURE__ */ React.createElement(BpNum, { money: true, value: p.annual, step: 1e3, onChange: (v) => updPhase(i, { annual: v }) }), /* @__PURE__ */ React.createElement("button", { className: "icon-btn", onClick: () => delPhase(i), disabled: bp.phases.length <= 1, title: "Remove phase" }, "\u2715")), /* @__PURE__ */ React.createElement("div", { className: "bp-phase-sum" }, "= ", yrs, " year", yrs === 1 ? "" : "s", " (", yrs === 1 ? "age " + p.fromAge : "ages " + p.fromAge + "\u2013" + p.toAge, ") \xB7 ", /* @__PURE__ */ React.createElement("b", null, gbpC(yrs * (p.annual || 0))), " total"));
  }), /* @__PURE__ */ React.createElement("button", { className: "add-link", onClick: addPhase }, "+ Add contribution phase")), /* @__PURE__ */ React.createElement("div", { className: "bp-note" }, /* @__PURE__ */ React.createElement("b", null, "From and To are inclusive"), " \u2014 \u201C35 to 36\u201D is 2 years (ages 35 and 36). Phases ", /* @__PURE__ */ React.createElement("b", null, "stack"), ": if two ranges cover the same age, their amounts add there \u2014 so a one-off like a ", /* @__PURE__ */ React.createElement("b", null, "\xA3400k lump at 36"), " is just a single-year phase (36 to 36) on top of recurring saving. The year-by-year table shows the combined amount at each age. Contributions are in today\u2019s money and shown as entered (not inflated). A \xA30 phase stops contributions."), /* @__PURE__ */ React.createElement("details", { className: "bp-collapse" }, /* @__PURE__ */ React.createElement("summary", { className: "bp-sub bp-summary" }, "Advanced \xB7 bridge framing & scenarios"), /* @__PURE__ */ React.createElement("div", { className: "bp-toggles" }, /* @__PURE__ */ React.createElement("div", { className: "bp-tgroup" }, /* @__PURE__ */ React.createElement("span", { className: "tl" }, "Contributions"), /* @__PURE__ */ React.createElement("div", { className: "bp-seg" }, /* @__PURE__ */ React.createElement("button", { className: bp.frequency === "annual" ? "on" : "", onClick: () => setBp({ frequency: "annual" }) }, "Annual"), /* @__PURE__ */ React.createElement("button", { className: bp.frequency === "monthly" ? "on" : "", onClick: () => setBp({ frequency: "monthly" }) }, "Monthly"))), /* @__PURE__ */ React.createElement("div", { className: "bp-tgroup" }, /* @__PURE__ */ React.createElement("span", { className: "tl" }, "Drawdowns (secondary)"), /* @__PURE__ */ React.createElement("div", { className: "bp-seg" }, /* @__PURE__ */ React.createElement("button", { className: !bp.drawdownFromOptionality ? "on" : "", onClick: () => setBp({ drawdownFromOptionality: false }), title: "Keep accumulating \u2014 the pure 'when do I reach the target' view" }, "Off"), /* @__PURE__ */ React.createElement("button", { className: bp.drawdownFromOptionality ? "on" : "", onClick: () => setBp({ drawdownFromOptionality: true }), title: "From optionality age, stop saving and draw the target income to see how the pot evolves" }, "From optionality"))), bp.drawdownFromOptionality && /* @__PURE__ */ React.createElement("div", { className: "bp-tgroup" }, /* @__PURE__ */ React.createElement("span", { className: "tl" }, "At pension access"), /* @__PURE__ */ React.createElement("div", { className: "bp-seg" }, /* @__PURE__ */ React.createElement("button", { className: bp.stopDrawAtAccess !== true ? "on" : "", onClick: () => setBp({ stopDrawAtAccess: false }), title: "Keep drawing from ISA/GIA to life expectancy \u2014 shows whether accessible wealth alone lasts" }, "Keep drawing"), /* @__PURE__ */ React.createElement("button", { className: bp.stopDrawAtAccess === true ? "on" : "", onClick: () => setBp({ stopDrawAtAccess: true }), title: "Stop drawing from ISA/GIA at pension access \u2014 your pension takes over from then" }, "Stop at ", bp.pensionAccessAge)))), bp.drawdownFromOptionality && /* @__PURE__ */ React.createElement("div", { className: "bp-note", style: { marginTop: 0, marginBottom: 10 } }, "Drawdown view: from optionality (age ", base.crossAge != null ? base.crossAge : "\u2014", ") contributions stop and the pot pays out ", /* @__PURE__ */ React.createElement("b", null, gbpC(bp.targetIncome), "/yr"), ". ", base.depletionAge ? /* @__PURE__ */ React.createElement("span", null, "On accessible wealth alone it ", /* @__PURE__ */ React.createElement("b", { style: { color: "var(--critical)" } }, "runs out at age ", base.depletionAge), " \u2014 from pension access (", bp.pensionAccessAge, ") your pension is meant to take over (see the combined charts below).") : /* @__PURE__ */ React.createElement("span", null, "The pot ", /* @__PURE__ */ React.createElement("b", null, "sustains"), " the withdrawals out to ", bp.lifeExpectancy || 90, " \u2014 your drawdown is covered by growth."), " Turn this off in Advanced for pure accumulation."), /* @__PURE__ */ React.createElement("div", { className: "bp-scenarios" }, [{ key: "base", label: "Base", color: C.pension }, { key: "conservative", label: "Conservative", color: C.gia }, { key: "optimistic", label: "Optimistic", color: C.isa }].map((sc) => {
    const isBase = sc.key === "base";
    const s = isBase ? { growth: bp.growth, inflation: bp.inflation, contribScale: 1 } : bp.scenarios[sc.key] || {};
    const scInfl = s.inflation != null ? s.inflation : bp.inflation;
    const res = isBase ? base : sc.key === "conservative" ? cons : opt;
    return /* @__PURE__ */ React.createElement("div", { className: "bp-scard" + (isBase ? " base" : ""), key: sc.key }, /* @__PURE__ */ React.createElement("div", { className: "bp-scard-head" }, /* @__PURE__ */ React.createElement("span", { className: "sn" }, /* @__PURE__ */ React.createElement("span", { className: "cd", style: { background: sc.color } }), sc.label, isBase && " (primary)"), !isBase && /* @__PURE__ */ React.createElement("button", { className: "bp-scen-toggle", onClick: () => updScen(sc.key, { enabled: !scEnabled[sc.key] }) }, scEnabled[sc.key] ? "On chart \u2713" : "Show on chart")), /* @__PURE__ */ React.createElement("div", { className: "bp-scard-sub" }, (s.growth * 100).toFixed(0), "% return \xB7 ", (scInfl * 100).toFixed(1), "% inflation \u2192 ", (((1 + s.growth) / (1 + scInfl) - 1) * 100).toFixed(1), "% real"), isBase ? /* @__PURE__ */ React.createElement("div", { className: "bp-note", style: { margin: "2px 0 6px" } }, "Uses your Key assumptions above. Edit the return / inflation there to move this line.") : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "bp-fld" }, /* @__PURE__ */ React.createElement("label", null, "Nominal return"), /* @__PURE__ */ React.createElement(
      BpNum,
      {
        pct: true,
        value: +((s.growth || 0) * 100).toFixed(2),
        step: "0.1",
        onChange: (v) => updScen(sc.key, { growth: (v || 0) / 100 })
      }
    )), /* @__PURE__ */ React.createElement("div", { className: "bp-fld" }, /* @__PURE__ */ React.createElement("label", null, "Inflation"), /* @__PURE__ */ React.createElement(
      BpNum,
      {
        pct: true,
        value: +((scInfl || 0) * 100).toFixed(2),
        step: "0.1",
        onChange: (v) => updScen(sc.key, { inflation: (v || 0) / 100 })
      }
    )), /* @__PURE__ */ React.createElement("div", { className: "bp-fld" }, /* @__PURE__ */ React.createElement("label", null, "Contributions (\xD7 Base)"), /* @__PURE__ */ React.createElement(
      BpNum,
      {
        pct: true,
        value: +((s.contribScale != null ? s.contribScale : 1) * 100).toFixed(0),
        step: "5",
        onChange: (v) => updScen(sc.key, { contribScale: (v || 0) / 100 })
      }
    ))), /* @__PURE__ */ React.createElement("div", { className: "cross-line" }, "Optionality: ", /* @__PURE__ */ React.createElement("b", null, res.crossAge != null ? "age " + res.crossAge : "not by " + bp.pensionAccessAge), res.crossAge != null && " \xB7 target " + gbpC(res.perpetualPot)));
  }))), /* @__PURE__ */ React.createElement("details", { className: "bp-collapse" }, /* @__PURE__ */ React.createElement("summary", { className: "bp-sub bp-summary" }, "Year-by-year \xB7 age ", bp.currentAge, "\u2013", bp.pensionAccessAge), /* @__PURE__ */ React.createElement("div", { className: "tablewrap cards" }, /* @__PURE__ */ React.createElement("table", null, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("th", null, "Age"), /* @__PURE__ */ React.createElement("th", null, "Projected ISA/GIA"), /* @__PURE__ */ React.createElement("th", null, "Contribution"), /* @__PURE__ */ React.createElement("th", null, "Withdrawal"), /* @__PURE__ */ React.createElement("th", null, "Market growth"), /* @__PURE__ */ React.createElement("th", null, "Target balance"), /* @__PURE__ */ React.createElement("th", null, "Surplus / shortfall"), /* @__PURE__ */ React.createElement("th", null, "Supported income"), /* @__PURE__ */ React.createElement("th", null, "Status"))), /* @__PURE__ */ React.createElement("tbody", null, base.rows.map((r, i) => {
    const st = rowStatus(r);
    return /* @__PURE__ */ React.createElement("tr", { key: i, className: rowClass(r) + (r.age === base.crossAge ? " bp-cross-row" : "") }, /* @__PURE__ */ React.createElement("td", { "data-label": "Age" }, r.age), /* @__PURE__ */ React.createElement("td", { "data-label": "Projected ISA/GIA" }, m(r.balance, r.age)), /* @__PURE__ */ React.createElement("td", { "data-label": "Contribution" }, r.contribution ? m(r.contribution, r.age) : "\u2014"), /* @__PURE__ */ React.createElement("td", { "data-label": "Withdrawal" }, r.withdraw ? /* @__PURE__ */ React.createElement("span", { style: { color: "var(--critical)" } }, m(-r.withdraw, r.age)) : "\u2014"), /* @__PURE__ */ React.createElement("td", { "data-label": "Market growth", className: "bp-growth" }, (function() {
      var w = r.withdraw || 0;
      var g = (r.balance + r.contribution - w + r.growth) * bf(r.age + 1) - r.balance * bf(r.age) - r.contribution * bf(r.age) + w * bf(r.age);
      return (g >= 0 ? "+" : "\u2212") + gbpC(Math.abs(g));
    })()), /* @__PURE__ */ React.createElement("td", { "data-label": "Target balance" }, m(r.target, r.age)), /* @__PURE__ */ React.createElement("td", { "data-label": "Surplus / shortfall", style: { color: r.surplus >= 0 ? "var(--good-text)" : "var(--critical)" } }, (r.surplus >= 0 ? "+" : "\u2212") + m(Math.abs(r.surplus), r.age)), /* @__PURE__ */ React.createElement("td", { "data-label": "Supported income" }, m(r.income, r.age), "/yr"), /* @__PURE__ */ React.createElement("td", { "data-label": "Status" }, /* @__PURE__ */ React.createElement("span", { className: "bp-status " + st[0] }, st[1])));
  })))), /* @__PURE__ */ React.createElement("div", { className: "bp-note" }, "Red below target \xB7 amber within 10% \xB7 green once the target is reached. Figures in ", realTerms ? "today\u2019s money" : "future \xA3 (nominal)", ". This is a planning model, not financial advice.")));
}
function CoastPlanner({ cp, setCp, plan, C, realTerms, setRealTerms }) {
  const base = plan.base, cons = plan.conservative, opt = plan.optimistic;
  const narrow = useIsNarrow();
  const bf = (age) => realTerms ? 1 : Math.pow(1 + (cp.inflation || 0), (age || cp.currentAge) - cp.currentAge);
  const m = (v, age) => gbpC(v * bf(age));
  const scEnabled = {
    conservative: !!(cp.scenarios && cp.scenarios.conservative && cp.scenarios.conservative.enabled),
    optimistic: !!(cp.scenarios && cp.scenarios.optimistic && cp.scenarios.optimistic.enabled)
  };
  const data = base.rows.map((r, i) => {
    const o = { age: r.age, required: r.required * bf(r.age), projected: r.projected * bf(r.age) };
    if (scEnabled.conservative && cons.rows[i]) o.cons = cons.rows[i].projected * bf(r.age);
    if (scEnabled.optimistic && opt.rows[i]) o.opt = opt.rows[i].projected * bf(r.age);
    return o;
  });
  const stopData = plan.stopSchedule.map((s) => ({ stopAge: s.stopAge, final: s.finalPension * bf(cp.retirementAge), target: plan.targetPot * bf(cp.retirementAge) }));
  const updScen = (key, patch) => setCp({ scenarios: Object.assign({}, cp.scenarios, { [key]: Object.assign({}, (cp.scenarios || {})[key], patch) }) });
  const updPhase = (i, patch) => setCp({ phases: cp.phases.map((p, idx) => idx === i ? Object.assign({}, p, patch) : p) });
  const addPhase = () => {
    const last = cp.phases[cp.phases.length - 1];
    const from = last ? (last.toAge || cp.currentAge) + 1 : cp.currentAge;
    setCp({ phases: cp.phases.concat([{ fromAge: from, toAge: Math.max(from, cp.retirementAge), annual: 0 }]) });
  };
  const delPhase = (i) => {
    if (cp.phases.length <= 1) return;
    setCp({ phases: cp.phases.filter((_, idx) => idx !== i) });
  };
  const rowClass = (r) => {
    if (r.drawing) return r.projected > 1 ? "bp-green" : "bp-below";
    const ratio = r.required > 0 ? r.projected / r.required : 2;
    return ratio >= 1 ? "bp-green" : ratio >= 0.9 ? "bp-amber" : "bp-below";
  };
  const rowStat = (r) => {
    if (r.drawing) return r.projected > 1 ? ["green", "Drawing"] : ["below", "Depleted"];
    const ratio = r.required > 0 ? r.projected / r.required : 2;
    return ratio >= 1 ? ["green", "Above"] : ratio >= 0.9 ? ["amber", "Close"] : ["below", "Below"];
  };
  const statusText = base.coasting ? "Already coasting" : base.reached ? base.yearsUntilCoast + (base.yearsUntilCoast === 1 ? " yr to coast" : " yrs to coast") : gbpC(base.shortfallNow) + " short";
  const ScenChip = ({ name, label, color, res, toggleable }) => /* @__PURE__ */ React.createElement(
    "button",
    {
      className: "bp-chip" + (toggleable && !scEnabled[name] ? " off" : ""),
      onClick: () => toggleable ? updScen(name, { enabled: !scEnabled[name] }) : null,
      title: toggleable ? "Show / hide this scenario on the chart" : "The primary scenario"
    },
    /* @__PURE__ */ React.createElement("span", { className: "cd", style: { background: color } }),
    label,
    /* @__PURE__ */ React.createElement("span", { className: "cage" }, res.coastAge != null ? "coast " + res.coastAge : "no coast by " + res.objAge)
  );
  return /* @__PURE__ */ React.createElement("div", { className: "bridge-planner" }, /* @__PURE__ */ React.createElement("div", { className: "bp-topline" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "bp-q" }, "Pension Coast \xB7 self-sustaining pension"), /* @__PURE__ */ React.createElement("div", { className: "bp-title" }, /* @__PURE__ */ React.createElement("span", { className: "bp-star" }, "\u2B50"), " Have I reached Pension Coast?")), /* @__PURE__ */ React.createElement("div", { className: "bp-terms" }, /* @__PURE__ */ React.createElement("div", { className: "bp-seg", role: "group", "aria-label": "value basis" }, /* @__PURE__ */ React.createElement("button", { className: realTerms ? "on" : "", onClick: () => setRealTerms(true) }, "Today\u2019s money"), /* @__PURE__ */ React.createElement("button", { className: !realTerms ? "on" : "", onClick: () => setRealTerms(false) }, "Nominal")))), /* @__PURE__ */ React.createElement("div", { className: "bp-headline" }, /* @__PURE__ */ React.createElement("div", { className: "bp-big " + (base.reached ? "reached" : "missed") }, base.coasting ? "Coasting now \u2014 pension self-funds" : base.reached ? base.yearsUntilCoast === 0 ? "Coast achieved at " + (base.coastAgeExact != null ? base.coastAgeExact.toFixed(1) : base.coastAge) : base.yearsUntilCoast + " more year" + (base.yearsUntilCoast === 1 ? "" : "s") + " of contributions \u2014 coast achieved at " + (base.coastAgeExact != null ? base.coastAgeExact.toFixed(1) : base.coastAge) : "Not reached by " + base.objAge), /* @__PURE__ */ React.createElement("div", { className: "bp-cap" }, base.reached ? "Pension becomes self-sustaining \u2014 at " + (base.coasting ? "your current balance" : "age " + base.coastAge) + " it reaches " + m(base.coastBalance, base.coastAge) + ", enough to grow to your " + gbpC(plan.targetPot * bf(base.objAge)) + " target by age " + base.objAge + (realTerms ? "" : " (that\u2019s your " + gbpC(plan.targetPot) + " target in today\u2019s money, grown by inflation to age " + base.objAge + ")") + ", with no further contributions." : "On these assumptions your pension doesn\u2019t reach the " + gbpC(plan.targetPot) + " target by age " + base.objAge + " even with your planned contributions. Increase contributions, growth, or push the retirement age.")), /* @__PURE__ */ React.createElement("details", { className: "bp-why" }, /* @__PURE__ */ React.createElement("summary", null, 'Why does "Coast" happen so early?'), /* @__PURE__ */ React.createElement("ol", null, /* @__PURE__ */ React.createElement("li", null, /* @__PURE__ */ React.createElement("b", null, "Coast"), " is the point where your existing pot, left to grow on its own, would still hit your target by age ", base.objAge, " \u2014 ", /* @__PURE__ */ React.createElement("b", null, "with no further contributions"), ". It's not when you retire, it's when saving becomes optional."), /* @__PURE__ */ React.createElement("li", null, "It lands early when your ", /* @__PURE__ */ React.createElement("b", null, "real return is high"), " \u2014 a big pot compounding for ", Math.max(0, base.objAge - cp.currentAge), " years does the heavy lifting, so even a modest balance today can coast."), /* @__PURE__ */ React.createElement("li", null, "From your target age (", base.objAge, ") the pension is ", /* @__PURE__ */ React.createElement("b", null, "drawn down"), " for income (less State Pension once it starts at ", cp.statePensionAge, "). Everything here is ", /* @__PURE__ */ React.createElement("b", null, "live from your inputs"), " \u2014 right now ", (cp.growth * 100).toFixed(1), "% \u2212 ", ((cp.inflation || 0) * 100).toFixed(1), "% \u2248 ", (((1 + cp.growth) / (1 + (cp.inflation || 0)) - 1) * 100).toFixed(1), "% real; change the return, inflation, contributions or target age above and the coast age, chart and drawdown recompute instantly."))), /* @__PURE__ */ React.createElement("div", { className: "bp-scen-chips" }, /* @__PURE__ */ React.createElement(ScenChip, { name: "base", label: "Base", color: C.pension, res: base, toggleable: false }), /* @__PURE__ */ React.createElement(ScenChip, { name: "conservative", label: "Conservative", color: C.gia, res: cons, toggleable: true }), /* @__PURE__ */ React.createElement(ScenChip, { name: "optimistic", label: "Optimistic", color: C.isa, res: opt, toggleable: true })), /* @__PURE__ */ React.createElement("div", { className: "bp-basis " + (realTerms ? "real" : "nom") }, realTerms ? /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("b", null, "Today\u2019s money (real)."), " Every figure is deflated by inflation into today\u2019s purchasing power. Your return is nominal, so higher inflation means less real growth \u2014 raising inflation makes these figures worse.") : /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("b", null, "Nominal (future \xA3)."), " The actual pounds of each future year, projected at your nominal return. Not adjusted for inflation, so they look bigger than their real worth.")), /* @__PURE__ */ React.createElement("div", { className: "bp-worked" }, /* @__PURE__ */ React.createElement("b", null, "Worked example:"), " ", gbpC(base.potAtObj), " in today\u2019s money is about ", gbpC(base.potAtObj * Math.pow(1 + cp.inflation, Math.max(0, base.objAge - cp.currentAge))), " in future pounds by age ", base.objAge, " (at ", (cp.inflation * 100).toFixed(1), "% inflation over ", Math.max(0, base.objAge - cp.currentAge), " years) \u2014 same pot, the toggle just relabels the units."), /* @__PURE__ */ React.createElement("div", { className: "bp-results" }, /* @__PURE__ */ React.createElement("div", { className: "bp-tile" }, /* @__PURE__ */ React.createElement("div", { className: "bt-k" }, "Status"), /* @__PURE__ */ React.createElement("div", { className: "bt-v " + (base.reached ? "pos" : "neg") }, statusText)), /* @__PURE__ */ React.createElement("div", { className: "bp-tile" }, /* @__PURE__ */ React.createElement("div", { className: "bt-k" }, "Coast balance needed"), /* @__PURE__ */ React.createElement("div", { className: "bt-v" }, base.coastBalance != null ? m(base.coastBalance, base.coastAge) : "\u2014")), /* @__PURE__ */ React.createElement("div", { className: "bp-tile" }, /* @__PURE__ */ React.createElement("div", { className: "bt-k" }, "Target pension @ ", base.objAge, realTerms ? "" : " (future \xA3)"), /* @__PURE__ */ React.createElement("div", { className: "bt-v" }, gbpC(plan.targetPot * bf(base.objAge))), !realTerms && /* @__PURE__ */ React.createElement("div", { className: "bt-sub" }, "= ", gbpC(plan.targetPot), " in today\u2019s money")), /* @__PURE__ */ React.createElement("div", { className: "bp-tile" }, /* @__PURE__ */ React.createElement("div", { className: "bt-k" }, "Projected pot @ ", base.objAge), /* @__PURE__ */ React.createElement("div", { className: "bt-v" }, m(base.potAtObj, base.objAge))), /* @__PURE__ */ React.createElement("div", { className: "bp-tile" }, /* @__PURE__ */ React.createElement("div", { className: "bt-k" }, "More years to contribute"), /* @__PURE__ */ React.createElement("div", { className: "bt-v" }, base.reached ? base.yearsUntilCoast === 0 ? "0 \u2014 done" : base.yearsUntilCoast : "\u2014"))), /* @__PURE__ */ React.createElement("div", { className: "bp-chart" }, ResponsiveContainer ? /* @__PURE__ */ React.createElement(ResponsiveContainer, { width: "100%", height: narrow ? 236 : 320 }, /* @__PURE__ */ React.createElement(LineChart, { data, margin: { top: 24, right: 18, left: 8, bottom: 2 } }, /* @__PURE__ */ React.createElement(CartesianGrid, { stroke: C.grid, vertical: false }), /* @__PURE__ */ React.createElement(XAxis, { dataKey: "age", stroke: C.axis, tick: { fontSize: narrow ? 10 : 11, fill: C.axis }, tickLine: false, axisLine: { stroke: C.baseline }, padding: { left: 4, right: 8 }, minTickGap: narrow ? 26 : 8, interval: "preserveStartEnd" }), /* @__PURE__ */ React.createElement(YAxis, { stroke: C.axis, tick: { fontSize: 11, fill: C.axis }, tickLine: false, axisLine: false, tickFormatter: gbpC, width: 52 }), /* @__PURE__ */ React.createElement(Tooltip, { content: /* @__PURE__ */ React.createElement(ChartTip, null) }), base.reached && !base.coasting && /* @__PURE__ */ React.createElement(
    ReferenceLine,
    {
      x: base.coastAge,
      stroke: C.good,
      strokeDasharray: "4 3",
      strokeWidth: 1.5,
      label: { value: "Coast " + base.coastAge, position: "insideTopRight", fill: C.good, fontSize: 11, fontWeight: 700 }
    }
  ), /* @__PURE__ */ React.createElement(ReferenceLine, { x: base.objAge, stroke: C.axis, strokeDasharray: "3 3", label: { value: (narrow ? "Draw " : "Retire / draw ") + base.objAge, position: "insideTop", fill: C.axis, fontSize: 10 } }), base.coastDepletionAge && /* @__PURE__ */ React.createElement(ReferenceLine, { x: base.coastDepletionAge, stroke: C.red, strokeWidth: 1.5, label: { value: (narrow ? "Out " : "Runs out ") + base.coastDepletionAge, position: "insideTopRight", fill: C.red, fontSize: 11, fontWeight: 700 } }), /* @__PURE__ */ React.createElement(Line, { type: "monotone", dataKey: "required", name: "Required coast balance", stroke: C.red, strokeWidth: 2, dot: false, strokeDasharray: "5 4" }), scEnabled.conservative && /* @__PURE__ */ React.createElement(Line, { type: "monotone", dataKey: "cons", name: "Conservative", stroke: C.gia, strokeWidth: 1.6, dot: false }), scEnabled.optimistic && /* @__PURE__ */ React.createElement(Line, { type: "monotone", dataKey: "opt", name: "Optimistic", stroke: C.isa, strokeWidth: 1.6, dot: false }), /* @__PURE__ */ React.createElement(Line, { type: "monotone", dataKey: "projected", name: "Projected pension", stroke: C.pension, strokeWidth: 2.6, dot: false }))) : /* @__PURE__ */ React.createElement("div", { className: "muted" }, "Chart library unavailable."), /* @__PURE__ */ React.createElement("div", { className: "legend-row", style: { marginBottom: 2 } }, /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("span", { className: "sw", style: { background: C.pension } }), "Projected pension (Base)"), /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("span", { className: "sw", style: { background: C.red } }), "Required coast balance"), scEnabled.conservative && /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("span", { className: "sw", style: { background: C.gia } }), "Conservative"), scEnabled.optimistic && /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("span", { className: "sw", style: { background: C.isa } }), "Optimistic"), /* @__PURE__ */ React.createElement("span", { className: "terms-tag" }, realTerms ? "today\u2019s money" : "future \xA3 (nominal)")), /* @__PURE__ */ React.createElement("div", { className: "bp-note", style: { marginTop: 6 } }, "From your retirement/target age (", base.objAge, ") contributions stop and the pension pays out ", /* @__PURE__ */ React.createElement("b", null, gbpC(base.drawIncome), "/yr"), cp.goalMode === "income" && cp.statePensionAmount > 0 ? /* @__PURE__ */ React.createElement("span", null, " (dropping to ", gbpC(Math.max(0, base.drawIncome - (cp.statePensionAmount || 0))), "/yr once the State Pension starts at ", cp.statePensionAge, ")") : null, ", shown in the Withdrawal column below. ", base.coastDepletionAge ? /* @__PURE__ */ React.createElement("span", null, "On these assumptions the pot ", /* @__PURE__ */ React.createElement("b", { style: { color: "var(--critical)" } }, "runs out at age ", base.coastDepletionAge), ".") : /* @__PURE__ */ React.createElement("span", null, "Growth still outpaces withdrawals here, so the pot keeps rising to age ", base.rows.length ? base.rows[base.rows.length - 1].age : 70, " \u2014 a sustainable drawdown."))), base.coasting && /* @__PURE__ */ React.createElement("div", { className: "cmp-rec", style: { marginTop: 12 } }, /* @__PURE__ */ React.createElement("b", null, "You\u2019ve reached Pension Coast."), " Your pension is projected to meet your retirement objective without further contributions. Additional pension contributions may raise retirement income, but likely add less ", /* @__PURE__ */ React.createElement("i", null, "flexibility"), " than investing into accessible assets (your ISA/GIA Bridge Fund), which can fund the years before pension access. Not advice \u2014 just noting the optimisation problem has changed."), /* @__PURE__ */ React.createElement("div", { className: "bp-sub" }, "Objective"), /* @__PURE__ */ React.createElement("div", { className: "bp-toggles" }, /* @__PURE__ */ React.createElement("div", { className: "bp-tgroup" }, /* @__PURE__ */ React.createElement("span", { className: "tl" }, "Plan against"), /* @__PURE__ */ React.createElement("div", { className: "bp-seg" }, /* @__PURE__ */ React.createElement("button", { className: cp.goalMode === "pot" ? "on" : "", onClick: () => setCp({ goalMode: "pot" }) }, "Target pension pot"), /* @__PURE__ */ React.createElement("button", { className: cp.goalMode === "income" ? "on" : "", onClick: () => setCp({ goalMode: "income" }) }, "Target retirement income"))), cp.goalMode === "pot" ? /* @__PURE__ */ React.createElement("div", { className: "bp-tgroup" }, /* @__PURE__ */ React.createElement("span", { className: "tl" }, "Target pension pot (today\u2019s money)"), /* @__PURE__ */ React.createElement(BpNum, { money: true, value: cp.targetPot, step: 5e4, onChange: (v) => setCp({ targetPot: v }) })) : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "bp-tgroup" }, /* @__PURE__ */ React.createElement("span", { className: "tl" }, "Desired income / yr"), /* @__PURE__ */ React.createElement(BpNum, { money: true, value: cp.targetIncome, step: 1e3, onChange: (v) => setCp({ targetIncome: v }) })), /* @__PURE__ */ React.createElement("div", { className: "bp-tgroup" }, /* @__PURE__ */ React.createElement("span", { className: "tl" }, "less State Pension / yr"), /* @__PURE__ */ React.createElement(BpNum, { money: true, value: cp.statePensionAmount || 0, step: 500, onChange: (v) => setCp({ statePensionAmount: v }) })), /* @__PURE__ */ React.createElement("div", { className: "bp-tgroup" }, /* @__PURE__ */ React.createElement("span", { className: "tl" }, "State Pension from age"), /* @__PURE__ */ React.createElement(BpNum, { value: cp.statePensionAge || 67, onChange: (v) => setCp({ statePensionAge: Math.round(v) }) })), /* @__PURE__ */ React.createElement("div", { className: "bp-tgroup" }, /* @__PURE__ */ React.createElement("span", { className: "tl" }, "Withdrawal rate"), /* @__PURE__ */ React.createElement(BpNum, { pct: true, value: +(cp.withdrawalRate * 100).toFixed(2), step: "0.1", onChange: (v) => setCp({ withdrawalRate: (v || 0) / 100 }) })), /* @__PURE__ */ React.createElement("div", { className: "bp-tgroup" }, /* @__PURE__ */ React.createElement("span", { className: "tl" }, "= Required pension @ ", base.objAge), /* @__PURE__ */ React.createElement("div", { className: "bp-tile", style: { padding: "8px 12px" } }, /* @__PURE__ */ React.createElement("div", { className: "bt-v", style: { fontSize: 16 } }, m(plan.targetPot, base.objAge)))))), /* @__PURE__ */ React.createElement("div", { className: "bp-note", style: { marginTop: 8 } }, (cp.statePensionAmount || 0) > 0 ? /* @__PURE__ */ React.createElement("span", null, "Your pension only needs to fund the income ", /* @__PURE__ */ React.createElement("b", null, "above"), " the State Pension: ", gbpC(cp.targetIncome), " \u2212 ", gbpC(cp.statePensionAmount), " = ", /* @__PURE__ */ React.createElement("b", null, gbpC(Math.max(0, cp.targetIncome - (cp.statePensionAmount || 0)))), "/yr, so the required pot is ", gbpC(plan.targetPot), ".", base.objAge < (cp.statePensionAge || 67) ? /* @__PURE__ */ React.createElement("span", null, " Because you retire at ", base.objAge, ", before the State Pension starts at ", cp.statePensionAge || 67, ", the pot also carries the capital to self-fund the ", /* @__PURE__ */ React.createElement("b", null, "full"), " ", gbpC(cp.targetIncome), "/yr for those ", (cp.statePensionAge || 67) - base.objAge, " year", (cp.statePensionAge || 67) - base.objAge === 1 ? "" : "s", " \u2014 the year-by-year table below draws the full income until ", cp.statePensionAge || 67, ", then nets off the State Pension.") : null, " The State Pension (from age ", cp.statePensionAge || 67, ") also reduces pot withdrawals in the lifetime charts below.") : /* @__PURE__ */ React.createElement("span", null, "No State Pension included \u2014 the pension funds the full ", gbpC(cp.targetIncome), "/yr. Add it above to model the ~\xA311.9k/yr it typically provides from age ", cp.statePensionAge || 67, ".")), /* @__PURE__ */ React.createElement("div", { className: "bp-sub" }, "Key assumptions"), /* @__PURE__ */ React.createElement("div", { className: "bp-assump" }, /* @__PURE__ */ React.createElement("div", { className: "bp-fld" }, /* @__PURE__ */ React.createElement("label", null, "Current age"), /* @__PURE__ */ React.createElement(BpNum, { value: cp.currentAge, step: "0.1", onChange: (v) => setCp({ currentAge: Math.round(v * 10) / 10 }) })), /* @__PURE__ */ React.createElement("div", { className: "bp-fld" }, /* @__PURE__ */ React.createElement("label", null, "Current pension"), /* @__PURE__ */ React.createElement(BpNum, { money: true, value: cp.currentPension, step: 1e3, onChange: (v) => setCp({ currentPension: v }) })), /* @__PURE__ */ React.createElement("div", { className: "bp-fld" }, /* @__PURE__ */ React.createElement("label", null, "Expected annual return (nominal)"), /* @__PURE__ */ React.createElement(BpNum, { pct: true, value: +(cp.growth * 100).toFixed(2), step: "0.1", onChange: (v) => setCp({ growth: (v || 0) / 100 }) })), /* @__PURE__ */ React.createElement("div", { className: "bp-fld" }, /* @__PURE__ */ React.createElement("label", null, "Inflation"), /* @__PURE__ */ React.createElement(BpNum, { pct: true, value: +(cp.inflation * 100).toFixed(2), step: "0.1", onChange: (v) => setCp({ inflation: (v || 0) / 100 }) })), /* @__PURE__ */ React.createElement("div", { className: "bp-fld" }, /* @__PURE__ */ React.createElement("label", null, "Retirement age (objective)"), /* @__PURE__ */ React.createElement(BpNum, { value: cp.retirementAge, onChange: (v) => setCp({ retirementAge: Math.round(v) }) })), /* @__PURE__ */ React.createElement("div", { className: "bp-fld" }, /* @__PURE__ */ React.createElement("label", null, "Pension access age"), /* @__PURE__ */ React.createElement(BpNum, { value: cp.pensionAccessAge, onChange: (v) => setCp({ pensionAccessAge: Math.round(v) }) }))), /* @__PURE__ */ React.createElement("div", { className: "bp-note" }, "Required coast balance at each age = target \xF7 (1+growth)^(years to ", base.objAge, ") \u2014 the pot that would grow to your target with ", /* @__PURE__ */ React.createElement("b", null, "no more contributions"), ". The engine converts the nominal return into a real return after inflation. Coast age is unchanged by the display toggle because targets and balances are converted consistently."), /* @__PURE__ */ React.createElement("div", { className: "bp-sub" }, "Contribution phases"), /* @__PURE__ */ React.createElement("div", { className: "bp-phases" }, /* @__PURE__ */ React.createElement("div", { className: "bp-phase-head" }, /* @__PURE__ */ React.createElement("span", null, "From age"), /* @__PURE__ */ React.createElement("span", null, "To age"), /* @__PURE__ */ React.createElement("span", null, "Annual contribution"), /* @__PURE__ */ React.createElement("span", null)), cp.phases.map((p, i) => {
    const yrs = p.toAge >= p.fromAge ? p.toAge - p.fromAge + 1 : 0;
    return /* @__PURE__ */ React.createElement(React.Fragment, { key: i }, /* @__PURE__ */ React.createElement("div", { className: "bp-phase" }, /* @__PURE__ */ React.createElement(BpNum, { value: p.fromAge, onChange: (v) => updPhase(i, { fromAge: Math.round(v) }) }), /* @__PURE__ */ React.createElement(BpNum, { value: p.toAge, onChange: (v) => updPhase(i, { toAge: Math.round(v) }) }), /* @__PURE__ */ React.createElement(BpNum, { money: true, value: p.annual, step: 1e3, onChange: (v) => updPhase(i, { annual: v }) }), /* @__PURE__ */ React.createElement("button", { className: "icon-btn", onClick: () => delPhase(i), disabled: cp.phases.length <= 1, title: "Remove phase" }, "\u2715")), /* @__PURE__ */ React.createElement("div", { className: "bp-phase-sum" }, "= ", yrs, " year", yrs === 1 ? "" : "s", " (", yrs === 1 ? "age " + p.fromAge : "ages " + p.fromAge + "\u2013" + p.toAge, ") \xB7 ", /* @__PURE__ */ React.createElement("b", null, gbpC(yrs * (p.annual || 0))), " total"));
  }), /* @__PURE__ */ React.createElement("button", { className: "add-link", onClick: addPhase }, "+ Add contribution phase")), /* @__PURE__ */ React.createElement("div", { className: "bp-note" }, /* @__PURE__ */ React.createElement("b", null, "From and To are inclusive"), " \u2014 \u201C35 to 36\u201D is 2 years. Phases ", /* @__PURE__ */ React.createElement("b", null, "stack"), ": overlapping ranges add at the shared age (the year-by-year table shows the combined amount). Contributions are shown as entered \u2014 not inflation-adjusted."), /* @__PURE__ */ React.createElement("details", { className: "bp-collapse" }, /* @__PURE__ */ React.createElement("summary", { className: "bp-sub bp-summary" }, "How many more years must I contribute?"), /* @__PURE__ */ React.createElement("div", { className: "bp-chart" }, /* @__PURE__ */ React.createElement("div", { className: "bp-note", style: { marginTop: 0, marginBottom: 8 } }, "Each point: your pension at age ", base.objAge, " ", /* @__PURE__ */ React.createElement("b", null, "if you stopped contributing at that age"), ". Where it meets the target is the last year you need to keep paying in \u2014 ", /* @__PURE__ */ React.createElement("b", null, base.reached ? base.yearsUntilCoast === 0 ? "you can stop now" : "about " + base.yearsUntilCoast + " more year" + (base.yearsUntilCoast === 1 ? "" : "s") : "not reached on these assumptions"), "."), ResponsiveContainer ? /* @__PURE__ */ React.createElement(ResponsiveContainer, { width: "100%", height: narrow ? 160 : 200 }, /* @__PURE__ */ React.createElement(LineChart, { data: stopData, margin: { top: 10, right: 18, left: 8, bottom: 2 } }, /* @__PURE__ */ React.createElement(CartesianGrid, { stroke: C.grid, vertical: false }), /* @__PURE__ */ React.createElement(XAxis, { dataKey: "stopAge", stroke: C.axis, tick: { fontSize: 11, fill: C.axis }, tickLine: false, axisLine: { stroke: C.baseline } }), /* @__PURE__ */ React.createElement(YAxis, { stroke: C.axis, tick: { fontSize: 11, fill: C.axis }, tickLine: false, axisLine: false, tickFormatter: gbpC, width: 52 }), /* @__PURE__ */ React.createElement(Tooltip, { content: /* @__PURE__ */ React.createElement(ChartTip, null) }), base.reached && !base.coasting && /* @__PURE__ */ React.createElement(ReferenceLine, { x: base.coastAge, stroke: C.good, strokeDasharray: "4 3", label: { value: "Stop " + base.coastAge, position: "insideTopRight", fill: C.good, fontSize: 11, fontWeight: 700 } }), /* @__PURE__ */ React.createElement(Line, { type: "monotone", dataKey: "target", name: "Target", stroke: C.red, strokeWidth: 2, dot: false, strokeDasharray: "5 4" }), /* @__PURE__ */ React.createElement(Line, { type: "monotone", dataKey: "final", name: "Pension at retirement if you stop then", stroke: C.pension, strokeWidth: 2.4, dot: false }))) : /* @__PURE__ */ React.createElement("div", { className: "muted" }, "Chart library unavailable."))), /* @__PURE__ */ React.createElement("details", { className: "bp-collapse" }, /* @__PURE__ */ React.createElement("summary", { className: "bp-sub bp-summary" }, "Year-by-year \xB7 age ", cp.currentAge, "\u2013", base.rows.length ? base.rows[base.rows.length - 1].age : base.objAge), /* @__PURE__ */ React.createElement("div", { className: "tablewrap cards" }, /* @__PURE__ */ React.createElement("table", null, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("th", null, "Age"), /* @__PURE__ */ React.createElement("th", null, "Projected pension"), /* @__PURE__ */ React.createElement("th", null, "Coast balance required"), /* @__PURE__ */ React.createElement("th", null, "Surplus / shortfall"), /* @__PURE__ */ React.createElement("th", null, "Annual contribution"), /* @__PURE__ */ React.createElement("th", null, "Withdrawal"), /* @__PURE__ */ React.createElement("th", null, "Market growth"), /* @__PURE__ */ React.createElement("th", null, "Status"))), /* @__PURE__ */ React.createElement("tbody", null, base.rows.map((r, i) => {
    const st = rowStat(r);
    return /* @__PURE__ */ React.createElement("tr", { key: i, className: rowClass(r) + (r.age === base.coastAge ? " bp-cross-row" : "") }, /* @__PURE__ */ React.createElement("td", { "data-label": "Age" }, r.age), /* @__PURE__ */ React.createElement("td", { "data-label": "Projected pension" }, m(r.projected, r.age)), /* @__PURE__ */ React.createElement("td", { "data-label": "Coast balance required" }, m(r.required, r.age)), /* @__PURE__ */ React.createElement("td", { "data-label": "Surplus / shortfall", style: { color: r.surplus >= 0 ? "var(--good-text)" : "var(--critical)" } }, (r.surplus >= 0 ? "+" : "\u2212") + m(Math.abs(r.surplus), r.age)), /* @__PURE__ */ React.createElement("td", { "data-label": "Annual contribution" }, r.contribution ? m(r.contribution, r.age) : "\u2014"), /* @__PURE__ */ React.createElement("td", { "data-label": "Withdrawal" }, r.withdraw ? /* @__PURE__ */ React.createElement("span", { style: { color: "var(--critical)" } }, m(-r.withdraw, r.age)) : "\u2014"), /* @__PURE__ */ React.createElement("td", { "data-label": "Market growth", className: "bp-growth" }, (function() {
      var w = r.withdraw || 0;
      var g = (r.projected + r.contribution - w + r.growth) * bf(r.age + 1) - r.projected * bf(r.age) - r.contribution * bf(r.age) + w * bf(r.age);
      return (g >= 0 ? "+" : "\u2212") + gbpC(Math.abs(g));
    })()), /* @__PURE__ */ React.createElement("td", { "data-label": "Status" }, /* @__PURE__ */ React.createElement("span", { className: "bp-status " + st[0] }, st[1])));
  }))))), /* @__PURE__ */ React.createElement("details", { className: "bp-collapse" }, /* @__PURE__ */ React.createElement("summary", { className: "bp-sub bp-summary" }, "Advanced \xB7 scenarios"), /* @__PURE__ */ React.createElement("div", { className: "bp-scenarios" }, [{ key: "base", label: "Base", color: C.pension }, { key: "conservative", label: "Conservative", color: C.gia }, { key: "optimistic", label: "Optimistic", color: C.isa }].map((scn) => {
    const isBase = scn.key === "base";
    const s = isBase ? { growth: cp.growth, inflation: cp.inflation } : cp.scenarios[scn.key] || {};
    const scInfl = s.inflation != null ? s.inflation : cp.inflation;
    const res = isBase ? base : scn.key === "conservative" ? cons : opt;
    return /* @__PURE__ */ React.createElement("div", { className: "bp-scard" + (isBase ? " base" : ""), key: scn.key }, /* @__PURE__ */ React.createElement("div", { className: "bp-scard-head" }, /* @__PURE__ */ React.createElement("span", { className: "sn" }, /* @__PURE__ */ React.createElement("span", { className: "cd", style: { background: scn.color } }), scn.label, isBase && " (primary)"), !isBase && /* @__PURE__ */ React.createElement("button", { className: "bp-scen-toggle", onClick: () => updScen(scn.key, { enabled: !scEnabled[scn.key] }) }, scEnabled[scn.key] ? "On chart \u2713" : "Show on chart")), /* @__PURE__ */ React.createElement("div", { className: "bp-scard-sub" }, (s.growth * 100).toFixed(0), "% return \xB7 ", (scInfl * 100).toFixed(1), "% inflation \u2192 ", (((1 + s.growth) / (1 + scInfl) - 1) * 100).toFixed(1), "% real"), isBase ? /* @__PURE__ */ React.createElement("div", { className: "bp-note", style: { margin: "2px 0 6px" } }, "Uses your assumptions above. Edit the return / inflation there to move this line.") : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "bp-fld" }, /* @__PURE__ */ React.createElement("label", null, "Nominal return"), /* @__PURE__ */ React.createElement(
      BpNum,
      {
        pct: true,
        value: +((s.growth || 0) * 100).toFixed(2),
        step: "0.1",
        onChange: (v) => updScen(scn.key, { growth: (v || 0) / 100 })
      }
    )), /* @__PURE__ */ React.createElement("div", { className: "bp-fld" }, /* @__PURE__ */ React.createElement("label", null, "Inflation"), /* @__PURE__ */ React.createElement(
      BpNum,
      {
        pct: true,
        value: +((scInfl || 0) * 100).toFixed(2),
        step: "0.1",
        onChange: (v) => updScen(scn.key, { inflation: (v || 0) / 100 })
      }
    ))), /* @__PURE__ */ React.createElement("div", { className: "cross-line" }, "Coast: ", /* @__PURE__ */ React.createElement("b", null, res.coastAge != null ? "age " + res.coastAge : "not by " + res.objAge)));
  })), /* @__PURE__ */ React.createElement("div", { className: "bp-note" }, "Scenarios differ only by market assumptions: ", /* @__PURE__ */ React.createElement("b", null, "Optimistic"), " 11% return / 2% inflation \xB7 ", /* @__PURE__ */ React.createElement("b", null, "Base"), " ", (cp.growth * 100).toFixed(0), "% / ", (cp.inflation * 100).toFixed(1), "% \xB7 ", /* @__PURE__ */ React.createElement("b", null, "Conservative"), " 7% / 3%. Red below the coast line \xB7 amber within 10% \xB7 green once self-sustaining. Figures in ", realTerms ? "today\u2019s money" : "future \xA3 (nominal)", ". Not financial advice.")));
}
function App() {
  const C = useColors();
  const narrow = useIsNarrow();
  const [inputs, setInputs] = useState(() => {
    let base = JSON.parse(JSON.stringify(Engine.DEFAULTS));
    try {
      const s = localStorage.getItem("optionality.inputs");
      if (s) base = Object.assign({}, JSON.parse(JSON.stringify(Engine.DEFAULTS)), JSON.parse(s));
    } catch (e) {
    }
    if (!Array.isArray(base.savingsPlan) || !base.savingsPlan.length) {
      base.savingsPlan = [{
        fromYear: 0,
        amount: base.annualSavings != null ? base.annualSavings : 1e4,
        allocPension: base.allocPension != null ? base.allocPension : 0.3
      }];
    }
    base.spendingInflationLinked = true;
    return base;
  });
  const [dark, setDark] = useState(() => {
    try {
      return localStorage.getItem("optionality.dark") === "1";
    } catch (e) {
      return false;
    }
  });
  const [showAllRows, setShowAllRows] = useState(false);
  const [realTerms, setRealTerms] = useState(() => {
    try {
      const v = localStorage.getItem("optionality.realTerms");
      return v == null ? true : v === "1";
    } catch (e) {
      return true;
    }
  });
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    try {
      localStorage.setItem("optionality.dark", dark ? "1" : "0");
    } catch (e) {
    }
  }, [dark]);
  useEffect(() => {
    try {
      localStorage.setItem("optionality.realTerms", realTerms ? "1" : "0");
    } catch (e) {
    }
  }, [realTerms]);
  useEffect(() => {
    try {
      localStorage.setItem("optionality.inputs", JSON.stringify(inputs));
    } catch (e) {
    }
  }, [inputs]);
  const [optMsg, setOptMsg] = useState(null);
  const set = (patch) => {
    setOptMsg(null);
    setInputs((prev) => Object.assign({}, prev, patch));
  };
  const optimiseSavings = () => {
    const res = Engine.optimisePlan(inputs);
    if (!res.changed) {
      setOptMsg({ ok: false, text: "Add some annual savings first, then I can optimise the split." });
      return;
    }
    const before = res.baselineAge, after = res.optionalityAge;
    setInputs((prev) => Object.assign({}, prev, { savingsPlan: res.savingsPlan, plannedStopAge: null }));
    if (before != null && after != null && before - after > 0.05) {
      setOptMsg({ ok: true, text: "Optimised \u2014 earliest optionality age " + ageStr(before) + " \u2192 " + ageStr(after) + " (" + monthsStr(Math.round((before - after) * 12)) + " earlier). Applied the split year by year below." });
    } else if (after != null) {
      setOptMsg({ ok: true, text: "Your allocation is already about optimal for the earliest age (" + ageStr(after) + "). I tidied the split below." });
    } else {
      setOptMsg({ ok: false, text: "Even the best split can\u2019t reach optionality with these assumptions \u2014 try saving more or spending less." });
    }
  };
  const [bridgeInputs, setBridgeInputs] = useState(() => {
    let b = JSON.parse(JSON.stringify(Engine.BRIDGE_DEFAULTS));
    try {
      const s = localStorage.getItem("optionality.bridge");
      if (s) b = Object.assign({}, JSON.parse(JSON.stringify(Engine.BRIDGE_DEFAULTS)), JSON.parse(s));
    } catch (e) {
    }
    if (!Array.isArray(b.phases) || !b.phases.length) b.phases = JSON.parse(JSON.stringify(Engine.BRIDGE_DEFAULTS.phases));
    if (!b.scenarios) b.scenarios = JSON.parse(JSON.stringify(Engine.BRIDGE_DEFAULTS.scenarios));
    if (b.lumpSum > 0 && b.lumpSumAge != null) {
      const exists = b.phases.some((p) => p.fromAge === b.lumpSumAge && p.toAge === b.lumpSumAge && p.annual === b.lumpSum);
      if (!exists) b.phases = b.phases.concat([{ fromAge: b.lumpSumAge, toAge: b.lumpSumAge, annual: b.lumpSum }]);
    }
    delete b.lumpSum;
    delete b.lumpSumAge;
    if (!b._bv || b._bv < 2) {
      b.drawdownFromOptionality = true;
      if (b.lifeExpectancy == null) b.lifeExpectancy = 90;
      b._bv = 2;
    }
    if (b._bv < 3) {
      if (b.growth === 0.07) b.growth = 0.09;
      if (b.scenarios) {
        if (b.scenarios.conservative && b.scenarios.conservative.growth === 0.05) b.scenarios.conservative.growth = 0.07;
        if (b.scenarios.optimistic && b.scenarios.optimistic.growth === 0.09) b.scenarios.optimistic.growth = 0.11;
      }
      b._bv = 3;
    }
    if (b._bv < 4) {
      const ds = JSON.parse(JSON.stringify(Engine.BRIDGE_DEFAULTS.scenarios));
      const wasOn = b.scenarios || {};
      ds.conservative.enabled = !!(wasOn.conservative && wasOn.conservative.enabled);
      ds.optimistic.enabled = !!(wasOn.optimistic && wasOn.optimistic.enabled);
      b.scenarios = ds;
      b._bv = 4;
    }
    return b;
  });
  useEffect(() => {
    try {
      localStorage.setItem("optionality.bridge", JSON.stringify(bridgeInputs));
    } catch (e) {
    }
  }, [bridgeInputs]);
  const setBp = (patch) => setBridgeInputs((prev) => Object.assign({}, prev, patch));
  const bridge = useMemo(() => Engine.bridgePlan(bridgeInputs), [bridgeInputs]);
  const [coastInputs, setCoastInputs] = useState(() => {
    let c = JSON.parse(JSON.stringify(Engine.COAST_DEFAULTS));
    try {
      const s = localStorage.getItem("optionality.coast");
      if (s) c = Object.assign({}, JSON.parse(JSON.stringify(Engine.COAST_DEFAULTS)), JSON.parse(s));
    } catch (e) {
    }
    if (!Array.isArray(c.phases) || !c.phases.length) c.phases = JSON.parse(JSON.stringify(Engine.COAST_DEFAULTS.phases));
    if (!c.scenarios) c.scenarios = JSON.parse(JSON.stringify(Engine.COAST_DEFAULTS.scenarios));
    if (!c._cv || c._cv < 2) {
      if (c.statePensionAmount == null) c.statePensionAmount = 11900;
      if (c.statePensionAge == null) c.statePensionAge = 67;
      c._cv = 2;
    }
    if (c._cv < 3) {
      if (c.growth === 0.07) c.growth = 0.09;
      if (c.scenarios) {
        if (c.scenarios.conservative && c.scenarios.conservative.growth === 0.05) c.scenarios.conservative.growth = 0.07;
        if (c.scenarios.optimistic && c.scenarios.optimistic.growth === 0.09) c.scenarios.optimistic.growth = 0.11;
      }
      c._cv = 3;
    }
    if (c._cv < 4) {
      const ds = JSON.parse(JSON.stringify(Engine.COAST_DEFAULTS.scenarios));
      const wasOn = c.scenarios || {};
      ds.conservative.enabled = !!(wasOn.conservative && wasOn.conservative.enabled);
      ds.optimistic.enabled = !!(wasOn.optimistic && wasOn.optimistic.enabled);
      c.scenarios = ds;
      c._cv = 4;
    }
    return c;
  });
  useEffect(() => {
    try {
      localStorage.setItem("optionality.coast", JSON.stringify(coastInputs));
    } catch (e) {
    }
  }, [coastInputs]);
  const setCp = (patch) => setCoastInputs((prev) => Object.assign({}, prev, patch));
  const coast = useMemo(() => Engine.coastPlan(coastInputs), [coastInputs]);
  const combined = useMemo(() => Engine.combinedPlan(bridgeInputs, coastInputs), [bridgeInputs, coastInputs]);
  const cwData = combined.series.map(function(r) {
    var nf = realTerms ? 1 : Math.pow(1 + combined.infl, r.age - combined.startAge);
    return {
      age: r.age,
      pension: r.pension * nf,
      accessible: r.accessible * nf,
      netWorth: r.netWorth * nf,
      pensionIn: r.pensionIn * nf,
      accessibleIn: r.accessibleIn * nf,
      pensionOut: -r.pensionOut * nf,
      accessibleOut: -r.accessibleOut * nf
    };
  });
  const result = useMemo(() => Engine.compute(inputs), [inputs]);
  const opps = useMemo(() => Engine.opportunities(inputs), [inputs]);
  const rks = useMemo(() => Engine.risks(inputs), [inputs]);
  const rec = useMemo(() => Engine.recommendation(inputs), [inputs]);
  const buffer = useMemo(() => Engine.freedomBuffer(inputs), [inputs]);
  const [strategy, setStrategy] = useState("balanced");
  const [showWhy, setShowWhy] = useState(false);
  const [compareAmount, setCompareAmount] = useState(1e5);
  const comparison = useMemo(() => Engine.decisionComparator(inputs, compareAmount), [inputs, compareAmount]);
  const chosenStrat = rec.strategies.find((s) => s.key === strategy) || rec.strategies[0];
  const mstones = useMemo(() => Engine.milestones(inputs, result), [inputs, result]);
  const applyPatch = (patch) => set(Object.assign({}, patch));
  const applyStrategy = (allocP) => {
    const p = inputs.savingsPlan && inputs.savingsPlan.length ? inputs.savingsPlan : [{ fromYear: 0, amount: 0, allocPension: 0.3 }];
    let idx = 0;
    p.forEach((s, i) => {
      if ((s.fromYear || 0) < (p[idx].fromYear || 0)) idx = i;
    });
    set({ savingsPlan: p.map((s, i) => i === idx ? Object.assign({}, s, { allocPension: allocP }) : s) });
  };
  const nextEvent = useMemo(() => {
    const evs = (inputs.cashEvents || []).map((e) => {
      const yrs = e.yearsFromNow != null ? e.yearsFromNow : e.age != null ? e.age - inputs.currentAge : null;
      return yrs != null ? { name: e.name, amount: e.amount, direction: e.direction || "in", yrs } : null;
    }).filter((e) => e && e.yrs > 0.01 && e.direction === "in").sort((a, b) => a.yrs - b.yrs);
    if (!evs.length) return null;
    return { name: evs[0].name, amount: evs[0].amount, inMonths: Math.max(1, Math.round(evs[0].yrs * 12)) };
  }, [inputs]);
  const openSection = (key) => {
    const map = { personal: "sec-personal", pension: "sec-pension", events: "sec-events" };
    const el = document.getElementById(map[key]);
    if (el) {
      el.open = true;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };
  const rows = result.rows;
  const nw = result.netWorth;
  const totalNW = nw.total + nw.homeEquity;
  const rf = (age) => realTerms ? 1 / Math.pow(1 + inputs.inflation, (age || inputs.currentAge) - inputs.currentAge) : 1;
  const money = (v, age) => gbpC(v * rf(age));
  const gAcc = (v) => gbpC(v * rf(inputs.pensionAccessAge));
  const gFree = (v) => gbpC(v * rf(result.effectiveStop));
  const gLife = (v) => gbpC(v * rf(inputs.lifeExpectancy));
  const balStrat = rec.strategies.find((s) => s.key === "balanced") || chosenStrat;
  const yearsToFreedom = result.achievable ? Math.max(0, result.effectiveStop - inputs.currentAge) : null;
  const pensionFunded = result.pension.atAccess >= result.pension.required;
  const pensionAlmost = !pensionFunded && result.pension.atAccess >= result.pension.required * 0.9;
  const pensionStatus = !result.achievable ? { cls: "r", label: "\u2014" } : pensionFunded ? { cls: "g", label: "Fully funded" } : pensionAlmost ? { cls: "a", label: "Almost funded" } : { cls: "r", label: "Behind target" };
  const onTrackChip = !result.planSurvives ? { cls: "low", label: "Plan doesn\u2019t hold yet" } : inputs.targetOptionalityAge && result.effectiveStop > inputs.targetOptionalityAge + 0.5 ? { cls: "med", label: "Slightly behind" } : { cls: "good", label: "On track" };
  const priority = !result.achievable ? "closing the gap so the plan can fund your lifestyle at all" : !result.planSurvives ? "fixing the shortfall before you can stop" : pensionFunded ? "building accessible wealth (your Bridge Fund) so you can stop earlier" : "topping up your pension toward its target";
  const balDelta = result.optionalityAge != null && balStrat && balStrat.age != null ? Math.round((result.optionalityAge - balStrat.age) * 12) : 0;
  const planLines = [];
  if (balStrat) {
    if (balStrat.split.pension > 0) planLines.push("Keep contributing about " + gbp(balStrat.split.pension) + " to your pension (at least your employer match and any tax-efficient minimum).");
    else planLines.push("Your pension needs no more contributions to hit its target \u2014 keep any employer match, and redirect the rest to accessible savings.");
    if (balStrat.split.isa > 0) planLines.push("Max your ISA (" + gbp(Math.min(balStrat.split.isa, 2e4)) + ").");
    if (balStrat.split.gia > 0) planLines.push("Invest the remaining " + gbp(balStrat.split.gia) + " in your GIA.");
  }
  const reqLine = realTerms ? result.pension.required * rf(inputs.pensionAccessAge) : result.pension.required;
  const chartData = rows.map((r) => ({
    age: r.age,
    pension: r.pensionEnd * rf(r.age),
    required: reqLine,
    isa: r.isa * rf(r.age),
    gia: r.gia * rf(r.age),
    cash: r.cash * rf(r.age),
    home: nw.homeEquity * rf(r.age),
    net: (r.netWorth + nw.homeEquity) * rf(r.age),
    contributions: r.contributions * rf(r.age),
    withdrawals: -r.withdrawals * rf(r.age),
    pensionWithdrawals: -r.pensionWithdraw * rf(r.age)
  }));
  const confMap = { high: ["good", "Strong"], medium: ["med", "Moderate"], low: ["low", "Low"] };
  const conf = confMap[result.confidence];
  const heroAge = result.overridden ? result.effectiveStop : result.achievable ? result.optionalityAge : null;
  const wd = result.withdrawal || {};
  const wdPct = (r) => r != null ? (r * 100).toFixed(1) + "%" : "\u2014";
  const wdWarn = result.planSurvives && wd.status && wd.status !== "safe" && wd.initialRate != null;
  const wdMsg = wdWarn ? "This plan starts by drawing about " + wdPct(wd.initialRate) + " of your pot a year at age " + ageStr(result.effectiveStop) + " \u2014 " + (wd.status === "high" ? "well above" : "above") + " your " + wdPct(wd.target) + " sustainable guide. It still lasts to age " + inputs.lifeExpectancy + " because the horizon is finite, the State Pension arrives at " + inputs.statePensionAge + ", and full returns are assumed to hold \u2014 but there\u2019s little margin for a bad run of markets." + (wd.sustainableAge != null && wd.sustainableAge > result.effectiveStop + 0.1 ? " To stay within your " + wdPct(wd.target) + " guide you\u2019d wait to about " + ageStr(wd.sustainableAge) + "." : "") : "";
  const legacy = result.endWorth;
  const legacyYears = inputs.retirementSpending > 0 ? legacy / inputs.retirementSpending : 0;
  const yearsClause = legacyYears >= 1 && legacyYears <= 60 ? " (\u2248" + Math.round(legacyYears) + " years of spending)" : "";
  let confidenceWhy;
  if (!result.planSurvives && result.failPhase === "bridge")
    confidenceWhy = "You end with about " + gbpC(legacy) + " at age " + inputs.lifeExpectancy + ", but most is locked in your pension until age " + inputs.pensionAccessAge + ". Your accessible savings (ISA/GIA/cash) run dry around age " + (result.failAge != null ? Math.floor(result.failAge) : "\u2014") + ", so you can\u2019t fund the bridge to pension access \u2014 you\u2019re about " + gbpC(result.bridgeShortfall) + " short of accessible savings. Fix it with a later stop age, more outside your pension, or an earlier access age \u2014 not by saving more into the pension.";
  else if (!result.planSurvives)
    confidenceWhy = "The plan genuinely runs out of money around age " + (result.failAge != null ? Math.floor(result.failAge) : inputs.lifeExpectancy) + " \u2014 spending outpaces what your savings and pensions can cover. Stop later, save more, or trim spending.";
  else if (result.confidence === "high")
    confidenceWhy = "Roomy cushion \u2014 about " + gbpC(legacy) + " left at age " + inputs.lifeExpectancy + yearsClause + ", so the plan absorbs weaker returns or higher costs.";
  else if (result.confidence === "medium")
    confidenceWhy = !result.overridden ? "This is the earliest age the plan just survives, so there\u2019s little spare by design (~" + gbpC(legacy) + " left at " + inputs.lifeExpectancy + "). Push the stop age later or save more to build a buffer." : "Some cushion \u2014 about " + gbpC(legacy) + " left at age " + inputs.lifeExpectancy + yearsClause + ".";
  else
    confidenceWhy = "Very tight \u2014 almost nothing left at age " + inputs.lifeExpectancy + ". Small changes in returns, inflation or spending could break the plan.";
  const exportCsv = () => {
    const head = [
      "Age",
      "Phase",
      "Pension Start",
      "Pension In",
      "Pension Out",
      "Pension Growth",
      "Pension End",
      "ISA/GIA Start",
      "ISA/GIA In",
      "ISA/GIA Out",
      "ISA/GIA Growth",
      "ISA/GIA End",
      "State Pension",
      "Net Worth",
      "Notes"
    ];
    const lines = [head.join(",")].concat(rows.map((r) => [
      r.age,
      r.phase,
      r.pensionStart,
      r.pensionIn,
      r.pensionWithdraw,
      r.pensionGrowth,
      r.pensionEnd,
      r.accessStart,
      r.accessIn,
      r.accessOut,
      r.growth,
      r.accessEnd,
      r.statePension,
      r.netWorth,
      '"' + (r.notes || "") + '"'
    ].join(",")));
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "optionality-cashflow.csv";
    a.click();
    URL.revokeObjectURL(url);
  };
  const reset = () => {
    if (confirm("Reset all inputs to defaults?")) {
      setInputs(JSON.parse(JSON.stringify(Engine.DEFAULTS)));
      setBridgeInputs(JSON.parse(JSON.stringify(Engine.BRIDGE_DEFAULTS)));
      setCoastInputs(JSON.parse(JSON.stringify(Engine.COAST_DEFAULTS)));
    }
  };
  const updEvent = (i, patch) => {
    const ev = inputs.cashEvents.map((e, idx) => idx === i ? Object.assign({}, e, patch) : e);
    set({ cashEvents: ev });
  };
  const addEvent = () => set({ cashEvents: inputs.cashEvents.concat([{ name: "New event", amount: 1e4, yearsFromNow: 5, direction: "in", account: "gia", destination: "gia" }]) });
  const plan = inputs.savingsPlan && inputs.savingsPlan.length ? inputs.savingsPlan : [{ fromYear: 0, amount: 0, allocPension: 0.3 }];
  let earliestIdx = 0;
  plan.forEach((s, i) => {
    if ((s.fromYear || 0) < (plan[earliestIdx].fromYear || 0)) earliestIdx = i;
  });
  const seg0 = plan[earliestIdx];
  const seg0alloc = seg0.allocPension != null ? seg0.allocPension : 0.3;
  const updSeg = (i, patch) => set({ savingsPlan: plan.map((s, idx) => idx === i ? Object.assign({}, s, patch) : s) });
  const addSeg = () => {
    const last = plan[plan.length - 1];
    set({ savingsPlan: plan.concat([{ fromYear: (last.fromYear || 0) + 1, amount: last.amount, allocPension: last.allocPension }]) });
  };
  const delSeg = (i) => {
    if (plan.length <= 1) return;
    set({ savingsPlan: plan.filter((_, idx) => idx !== i) });
  };
  const delEvent = (i) => set({ cashEvents: inputs.cashEvents.filter((_, idx) => idx !== i) });
  const lightFor = (s) => s === "ahead" ? "g" : s === "ontrack" ? "g" : "r";
  const overall = result.planSurvives && result.achievable ? result.confidence === "high" ? "g" : result.confidence === "medium" ? "a" : "r" : "r";
  const visibleRows = showAllRows ? rows : rows.filter((r, i) => i < 3 || r.phase !== "accumulation" || rows[i + 1] && rows[i + 1].phase !== "accumulation" || i % 2 === 0).slice(0, 40);
  return /* @__PURE__ */ React.createElement("div", { className: "wrap" }, /* @__PURE__ */ React.createElement("div", { className: "topbar" }, /* @__PURE__ */ React.createElement("div", { className: "brand" }, /* @__PURE__ */ React.createElement("span", { className: "dot" }), /* @__PURE__ */ React.createElement("h1", null, "Financial Optionality"), /* @__PURE__ */ React.createElement("span", { className: "muted", style: { fontSize: 13 } }, "Model your path to financial independence")), /* @__PURE__ */ React.createElement("div", { className: "toolbar" }, /* @__PURE__ */ React.createElement("button", { className: "btn subtle", onClick: () => setRealTerms(!realTerms), title: realTerms ? "All figures are in today\u2019s money (real terms) \u2014 what they\u2019re worth at today\u2019s prices. Click to show future pounds (nominal), which look bigger because of inflation." : "All figures are in future pounds (nominal) \u2014 inflated to the year they happen. Click to show today\u2019s money (real terms)." }, "\u24D8 ", realTerms ? "Today\u2019s money" : "Future \xA3"), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: () => setDark(!dark) }, dark ? "\u2600 Light" : "\u263E Dark"), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: exportCsv }, "\u2B07 CSV"), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: () => window.print() }, "\u2399 Print"), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: reset }, "\u21BA Reset"))), /* @__PURE__ */ React.createElement("div", { className: "layout" }, /* @__PURE__ */ React.createElement("main", { className: "main" }, /* @__PURE__ */ React.createElement("div", { className: "panel exec-sum" }, /* @__PURE__ */ React.createElement("div", { className: "es-head" }, "\u{1F4CB} Your plan today \u2014 what to do"), (function() {
    var cb = coast.base, bb = bridge.base, cAge = bridgeInputs.currentAge;
    var pen = cb.coasting ? { ic: "\u2705", t: /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("b", null, "Pension:"), " Complete \u2014 it already self-funds your target (coasting), so further pension contributions are optional.") } : cb.reached ? { ic: "\u{1F3AF}", t: /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("b", null, "Pension:"), " On track \u2014 you can stop contributing at ", /* @__PURE__ */ React.createElement("b", null, "age ", cb.coastAge), " (", cb.yearsUntilCoast, " more year", cb.yearsUntilCoast === 1 ? "" : "s", " of saving).") } : { ic: "\u26A0\uFE0F", t: /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("b", null, "Pension:"), " Behind \u2014 projected ", /* @__PURE__ */ React.createElement("b", null, gbpC(cb.potAtObj)), " vs your ", gbpC(coast.targetPot), " target by ", cb.objAge, ". Raise contributions or push the objective age.") };
    var lasts = bb.depletionAge == null || bb.depletionAge >= bridgeInputs.pensionAccessAge;
    var br;
    if (bb.crossAge == null) {
      var gap = Math.max(0, bridge.targetPot - bridgeInputs.currentBalance);
      br = { ic: "\u26A0\uFE0F", t: /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("b", null, "Bridge fund:"), " Not there yet \u2014 roughly ", /* @__PURE__ */ React.createElement("b", null, gbpC(gap)), " short of the pot needed to walk away. Keep saving or add a lump sum.") };
    } else if (!lasts) {
      br = { ic: "\u274C", t: /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("b", null, "Bridge fund:"), " Work-optional at ", bb.crossAge, ", but it runs dry at ", /* @__PURE__ */ React.createElement("b", null, "age ", bb.depletionAge), " \u2014 ", bridgeInputs.pensionAccessAge - bb.depletionAge, " year", bridgeInputs.pensionAccessAge - bb.depletionAge === 1 ? "" : "s", " short of pension access ", bridgeInputs.pensionAccessAge, ".") };
    } else {
      br = { ic: "\u2705", t: /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("b", null, "Bridge fund:"), " ", bb.crossAge <= cAge ? "Complete \u2014 you can walk away now" : "On track \u2014 work-optional at age " + bb.crossAge, "; it lasts to pension access ", bridgeInputs.pensionAccessAge, ".") };
    }
    var opt = bb.crossAge != null ? { ic: "\u{1F3AF}", t: /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("b", null, "Full optionality:"), " Age ", /* @__PURE__ */ React.createElement("b", null, bb.crossAge), cb.reached ? "" : " \u2014 though the pension is still building", ".") } : { ic: "\u{1F3AF}", t: /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("b", null, "Full optionality:"), " not reachable on the current plan \u2014 adjust savings, growth or targets below.") };
    return [pen, br, opt].map(function(l, i) {
      return /* @__PURE__ */ React.createElement("div", { className: "es-line", key: i }, /* @__PURE__ */ React.createElement("span", { className: "es-ic" }, l.ic), /* @__PURE__ */ React.createElement("span", null, l.t));
    });
  })(), /* @__PURE__ */ React.createElement("div", { className: "es-foot" }, "Synthesised from the two planners below \xB7 figures in today\u2019s money.")), /* @__PURE__ */ React.createElement("div", { className: "section-title" }, "When can my pension look after itself?"), /* @__PURE__ */ React.createElement(CoastPlanner, { cp: coastInputs, setCp, plan: coast, C, realTerms, setRealTerms }), /* @__PURE__ */ React.createElement("div", { className: "section-title" }, "When can I walk away from work?"), /* @__PURE__ */ React.createElement(BridgePlanner, { bp: bridgeInputs, setBp, plan: bridge, C, realTerms, setRealTerms }), /* @__PURE__ */ React.createElement("div", { className: "outputs-block" }, /* @__PURE__ */ React.createElement("div", { className: "section-title" }, "Combined net worth"), /* @__PURE__ */ React.createElement("div", { className: "panel" }, /* @__PURE__ */ React.createElement("div", { className: "chart-h" }, /* @__PURE__ */ React.createElement("h2", null, "Combined net worth")), /* @__PURE__ */ React.createElement("div", { className: "desc" }, "Pension + accessible ISA/GIA wealth to age 90 \u2014 building until you go work-optional (age ", combined.retireAge, "), then drawn down for retirement income. ", realTerms ? "Today\u2019s money." : "Future \xA3 (nominal)."), ResponsiveContainer ? /* @__PURE__ */ React.createElement(ResponsiveContainer, { width: "100%", height: narrow ? 200 : 260 }, /* @__PURE__ */ React.createElement(AreaChart, { data: cwData, margin: { top: 6, right: 12, left: 4, bottom: 0 } }, /* @__PURE__ */ React.createElement(CartesianGrid, { stroke: C.grid, vertical: false }), /* @__PURE__ */ React.createElement(XAxis, { dataKey: "age", stroke: C.axis, tick: { fontSize: narrow ? 10 : 11, fill: C.axis }, tickLine: false, axisLine: { stroke: C.baseline }, minTickGap: narrow ? 26 : 8, interval: "preserveStartEnd" }), /* @__PURE__ */ React.createElement(YAxis, { stroke: C.axis, tick: { fontSize: 11, fill: C.axis }, tickLine: false, axisLine: false, tickFormatter: gbpC, width: 46 }), /* @__PURE__ */ React.createElement(Tooltip, { content: /* @__PURE__ */ React.createElement(ChartTip, null) }), /* @__PURE__ */ React.createElement(ReferenceLine, { x: combined.retireAge, stroke: C.good, strokeDasharray: "3 3", label: { value: (narrow ? "Optional " : "Work-optional ") + combined.retireAge, position: "insideTopLeft", fill: C.good, fontSize: 11 } }), /* @__PURE__ */ React.createElement(ReferenceLine, { x: combined.pensionAccessAge, stroke: C.axis, strokeDasharray: "3 3", label: { value: (narrow ? "Access " : "Pension access ") + combined.pensionAccessAge, position: "insideTopRight", fill: C.axis, fontSize: 11 } }), /* @__PURE__ */ React.createElement(Area, { type: "monotone", dataKey: "accessible", name: "ISA / GIA", stackId: "1", stroke: C.isa, fill: C.isa, fillOpacity: 0.5 }), /* @__PURE__ */ React.createElement(Area, { type: "monotone", dataKey: "pension", name: "Pension", stackId: "1", stroke: C.pension, fill: C.pension, fillOpacity: 0.5 }))) : /* @__PURE__ */ React.createElement("div", { className: "muted" }, "Chart library unavailable."), /* @__PURE__ */ React.createElement("div", { className: "legend-row" }, /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("span", { className: "sw", style: { background: C.pension } }), "Pension (Coast)"), /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("span", { className: "sw", style: { background: C.isa } }), "ISA / GIA (Bridge)"), /* @__PURE__ */ React.createElement("span", { className: "terms-tag" }, realTerms ? "today\u2019s money" : "future \xA3 (nominal)"))), /* @__PURE__ */ React.createElement("div", { className: "panel", style: { marginBottom: 16 } }, /* @__PURE__ */ React.createElement("div", { className: "chart-h" }, /* @__PURE__ */ React.createElement("h2", null, "Annual cash flow")), /* @__PURE__ */ React.createElement("div", { className: "desc" }, "Money ", /* @__PURE__ */ React.createElement("b", null, "in"), " (contributions, above the line) and ", /* @__PURE__ */ React.createElement("b", null, "out"), " (retirement income drawn, below the line), by pot \u2014 to age 90."), ResponsiveContainer ? /* @__PURE__ */ React.createElement(ResponsiveContainer, { width: "100%", height: narrow ? 188 : 240 }, /* @__PURE__ */ React.createElement(ComposedChart, { data: cwData, margin: { top: 6, right: 12, left: 4, bottom: 0 }, stackOffset: "sign" }, /* @__PURE__ */ React.createElement(CartesianGrid, { stroke: C.grid, vertical: false }), /* @__PURE__ */ React.createElement(XAxis, { dataKey: "age", stroke: C.axis, tick: { fontSize: narrow ? 10 : 11, fill: C.axis }, tickLine: false, axisLine: { stroke: C.baseline }, minTickGap: narrow ? 26 : 8, interval: "preserveStartEnd" }), /* @__PURE__ */ React.createElement(YAxis, { stroke: C.axis, tick: { fontSize: 11, fill: C.axis }, tickLine: false, axisLine: false, tickFormatter: gbpC, width: 46 }), /* @__PURE__ */ React.createElement(Tooltip, { content: /* @__PURE__ */ React.createElement(ChartTip, null) }), /* @__PURE__ */ React.createElement(ReferenceLine, { y: 0, stroke: C.baseline }), /* @__PURE__ */ React.createElement(Bar, { dataKey: "pensionIn", name: "Into pension", fill: C.pension, maxBarSize: 16, stackId: "cf" }), /* @__PURE__ */ React.createElement(Bar, { dataKey: "accessibleIn", name: "Into ISA/GIA", fill: C.isa, maxBarSize: 16, stackId: "cf" }), /* @__PURE__ */ React.createElement(Bar, { dataKey: "accessibleOut", name: "From ISA/GIA", fill: C.red, maxBarSize: 16, stackId: "cf" }), /* @__PURE__ */ React.createElement(Bar, { dataKey: "pensionOut", name: "From pension", fill: C.gia, maxBarSize: 16, stackId: "cf" }))) : /* @__PURE__ */ React.createElement("div", { className: "muted" }, "Chart library unavailable."), /* @__PURE__ */ React.createElement("div", { className: "legend-row" }, /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("span", { className: "sw", style: { background: C.pension } }), "Into pension"), /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("span", { className: "sw", style: { background: C.isa } }), "Into ISA / GIA"), /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("span", { className: "sw", style: { background: C.gia } }), "From pension"), /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("span", { className: "sw", style: { background: C.red } }), "From ISA / GIA"))), /* @__PURE__ */ React.createElement("div", { className: "section-title" }, "Year-by-year"), /* @__PURE__ */ React.createElement("div", { className: "panel", style: { marginBottom: 16 } }, /* @__PURE__ */ React.createElement("div", { className: "chart-h", style: { marginBottom: 10 } }, /* @__PURE__ */ React.createElement("div", { className: "legend-row", style: { margin: 0 } }, /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("span", { className: "sw", style: { background: C.pension } }), "Pension"), /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("span", { className: "sw", style: { background: C.isa } }), "ISA / GIA"), /* @__PURE__ */ React.createElement("span", { className: "terms-tag" }, realTerms ? "today\u2019s money" : "future \xA3 (nominal)"))), /* @__PURE__ */ React.createElement("div", { className: "desc", style: { marginTop: 0, marginBottom: 10 } }, "Pension and accessible wealth side by side each year, from the two planners. Contributions shown as entered; balances and growth follow the toggle."), /* @__PURE__ */ React.createElement("div", { className: "tablewrap cards", style: { maxHeight: 520 } }, /* @__PURE__ */ React.createElement("table", null, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", { className: "grouprow" }, /* @__PURE__ */ React.createElement("th", null), /* @__PURE__ */ React.createElement("th", { colSpan: 5, className: "grp grp-p" }, "Pension"), /* @__PURE__ */ React.createElement("th", { colSpan: 5, className: "grp grp-a" }, "ISA / GIA"), /* @__PURE__ */ React.createElement("th", null)), /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("th", null, "Age"), /* @__PURE__ */ React.createElement("th", null, "Start"), /* @__PURE__ */ React.createElement("th", null, "In"), /* @__PURE__ */ React.createElement("th", null, "Out"), /* @__PURE__ */ React.createElement("th", null, "Growth"), /* @__PURE__ */ React.createElement("th", null, "End"), /* @__PURE__ */ React.createElement("th", null, "Start"), /* @__PURE__ */ React.createElement("th", null, "In"), /* @__PURE__ */ React.createElement("th", null, "Out"), /* @__PURE__ */ React.createElement("th", null, "Growth"), /* @__PURE__ */ React.createElement("th", null, "End"), /* @__PURE__ */ React.createElement("th", null, "Net worth"))), /* @__PURE__ */ React.createElement("tbody", null, combined.series.map(function(r, i) {
    var nf = realTerms ? 1 : Math.pow(1 + combined.infl, r.age - combined.startAge);
    var mv = function(v) {
      return gbpC(v * nf);
    };
    var nf1 = realTerms ? 1 : Math.pow(1 + combined.infl, r.age + 1 - combined.startAge);
    var gv = function(end, start, inn, out) {
      return gbpC(end * nf1 - start * nf - inn * nf + out * nf);
    };
    return /* @__PURE__ */ React.createElement("tr", { key: i }, /* @__PURE__ */ React.createElement("td", { "data-label": "Age" }, r.age), /* @__PURE__ */ React.createElement("td", { "data-label": "Pension start" }, mv(r.pension)), /* @__PURE__ */ React.createElement("td", { "data-label": "Pension in" }, r.pensionIn ? mv(r.pensionIn) : "\u2014"), /* @__PURE__ */ React.createElement("td", { "data-label": "Pension out" }, r.pensionOut ? /* @__PURE__ */ React.createElement("span", { style: { color: "var(--critical)" } }, mv(-r.pensionOut)) : "\u2014"), /* @__PURE__ */ React.createElement("td", { "data-label": "Pension growth" }, gv(r.pensionEnd, r.pension, r.pensionIn, r.pensionOut)), /* @__PURE__ */ React.createElement("td", { "data-label": "Pension end" }, gbpC(r.pensionEnd * nf1)), /* @__PURE__ */ React.createElement("td", { "data-label": "ISA/GIA start" }, mv(r.accessible)), /* @__PURE__ */ React.createElement("td", { "data-label": "ISA/GIA in" }, r.accessibleIn ? mv(r.accessibleIn) : "\u2014"), /* @__PURE__ */ React.createElement("td", { "data-label": "ISA/GIA out" }, r.accessibleOut ? /* @__PURE__ */ React.createElement("span", { style: { color: "var(--critical)" } }, mv(-r.accessibleOut)) : "\u2014"), /* @__PURE__ */ React.createElement("td", { "data-label": "ISA/GIA growth" }, gv(r.accessibleEnd, r.accessible, r.accessibleIn, r.accessibleOut)), /* @__PURE__ */ React.createElement("td", { "data-label": "ISA/GIA end" }, gbpC(r.accessibleEnd * nf1)), /* @__PURE__ */ React.createElement("td", { "data-label": "Net worth" }, /* @__PURE__ */ React.createElement("b", null, mv(r.netWorth))));
  })))))))));
}
ReactDOM.createRoot(document.getElementById("root")).render(/* @__PURE__ */ React.createElement(App, null));
