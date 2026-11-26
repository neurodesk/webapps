import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { APP, describePlan, distinctGroups, filterReportRows, formatMegabytes } from "../src/config.js";

describe("totalsegmentator config helpers", () => {
  it("keeps sidebar plan hints concise (<= 90 characters)", () => {
    assert.equal(APP.id, "totalsegmentator");
    const cases = [
      { task: "total", resolution: "fast", subset: "all" },
      { task: "total", resolution: "full", subset: "all" },
      { task: "total", resolution: "full", subset: "muscles" },
      { task: "total_mr", resolution: "fast", subset: "all" },
      { task: "total_mr", resolution: "full", subset: "all" },
      { task: "vertebrae_mr", resolution: "full", subset: "all" },
      { task: "abdominal_muscles", resolution: "full", subset: "all" },
    ];
    for (const c of cases) {
      const hint = describePlan(c);
      assert.ok(hint.length > 0 && hint.length <= 90, `hint too long (${hint.length}): ${hint}`);
    }
    assert.equal(formatMegabytes(33_157_943), "33 MB");
  });

  it("filters report rows by group, name, slug, and ID", () => {
    const rows = [
      { id: 1, slug: "spleen", name: "Spleen", group: "organs", groupLabel: "Organs" },
      { id: 26, slug: "vertebrae_L5", name: "Vertebrae L5", group: "vertebrae", groupLabel: "Vertebrae" },
      { id: 80, slug: "gluteus_maximus_left", name: "Gluteus maximus left", group: "muscles", groupLabel: "Muscles & bones" },
    ];
    assert.equal(distinctGroups(rows).length, 3);
    assert.equal(filterReportRows(rows, { group: "muscles" }).length, 1);
    assert.equal(filterReportRows(rows, { query: "L5" }).length, 1);
    assert.equal(filterReportRows(rows, { query: "80" }).length, 1);
    assert.equal(filterReportRows(rows, { group: "organs", query: "gluteus" }).length, 0);
  });
});
