/**
 * Mirrors renderer/model.js applyPipelineToText grep + regex behavior.
 * Run: node test/pipeline-apply.test.cjs
 */
function applyPipelineToText(text, pipeline) {
  let t = text == null ? "" : String(text);
  for (const step of pipeline) {
    if (step.op === "grep") {
      const pat = step.pattern || "";
      const lines = t.split(/\r?\n/);
      let re;
      try {
        re = new RegExp(pat, "im");
      } catch {
        re = null;
      }
      if (re) {
        t = lines.filter((line) => re.test(line)).join("\n");
      } else {
        const needle = pat.toLowerCase();
        t = lines.filter((l) => l.toLowerCase().includes(needle)).join("\n");
      }
    } else if (step.op === "regex") {
      try {
        const re = new RegExp(step.pattern, "im");
        const lines = t.split(/\r?\n/);
        t = lines.filter((line) => re.test(line)).join("\n");
      } catch {
        t = "";
      }
    }
  }
  return t;
}

function assert(cond, msg) {
  if (!cond) {
    throw new Error(msg);
  }
}

const md = "# Title\n\n## Section\n\nplain\n";

let out = applyPipelineToText(md, [{ op: "grep", pattern: "^# " }]);
assert(out === "# Title", `grep ^# : expected one line, got ${JSON.stringify(out)}`);

out = applyPipelineToText(md, [{ op: "regex", pattern: "^#+ " }]);
assert(
  out === "# Title\n## Section",
  `regex ^#+  : expected H1+H2 lines, got ${JSON.stringify(out)}`,
);

out = applyPipelineToText("alpha\nbeta (x tail", [{ op: "grep", pattern: "(x" }]);
assert(
  out === "beta (x tail",
  "invalid-regex grep pattern falls back to substring match",
);

console.log("pipeline-apply.test.cjs: ok");
