import { describe, expect, test } from "bun:test";
import { visitLabel } from "./visitLabels";

const projectPath = "/projects/2ofbll96a9lqj";

describe("recent and pinned visit labels", () => {
  test("repairs a previously saved project costs path", () => {
    const path = `${projectPath}/costs`;

    expect(visitLabel({ path, title: path })).toBe("Projektkosten");
    expect(visitLabel({ path, title: "/projects/2ofbll96a9lqj/c…" })).toBe(
      "Projektkosten",
    );
  });

  test("handles missing titles, search parameters and trailing slashes", () => {
    for (const title of [null, undefined, "", "   ", "Sortsys"]) {
      expect(
        visitLabel({
          path: `${projectPath}/costs/?period=month#totals`,
          title,
        }),
      ).toBe("Projektkosten");
    }
  });

  test("preserves meaningful project names and hyphenated titles", () => {
    const path = `${projectPath}/costs`;

    expect(visitLabel({ path, title: "School - East wing" })).toBe(
      "School - East wing",
    );
    expect(visitLabel({ path, title: "School | Construction" })).toBe(
      "School | Construction",
    );
    expect(visitLabel({ path, title: "  School - Sortsys  " })).toBe("School");
  });

  test("uses tab-specific fallbacks for other project pages", () => {
    expect(visitLabel({ path: projectPath })).toBe("Projekt");
    expect(visitLabel({ path: `${projectPath}/files` })).toBe("Projektanhänge");
    expect(visitLabel({ path: `${projectPath}/dailyReports` })).toBe(
      "Bautagesberichte",
    );
    expect(visitLabel({ path: `${projectPath}/regieReports` })).toBe(
      "Regieberichte",
    );
  });

  test("keeps static route names instead of stale captured page titles", () => {
    expect(
      visitLabel({ path: "/projects/costs", title: "Previous page" }),
    ).toBe("Kostenübersicht");
    expect(
      visitLabel({ path: "/projects?archived=1", title: "/projects" }),
    ).toBe("Projekte");
  });

  test("preserves the current and legacy LLM route labels", () => {
    expect(visitLabel({ path: "/llm/chat/abc" })).toBe("LLM");
    expect(visitLabel({ path: "/assistant?chat=abc" })).toBe("LLM");
  });

  test("never exposes raw paths or URLs as unknown route labels", () => {
    expect(visitLabel({ path: "/unknown/abc", title: "/unknown/abc" })).toBe(
      "Seite",
    );
    expect(
      visitLabel({
        path: `${projectPath}/costs`,
        title: `https://example.test${projectPath}/costs`,
      }),
    ).toBe("Projektkosten");
    expect(
      visitLabel({ path: "/unknown/abc", title: "Useful page title" }),
    ).toBe("Useful page title");
  });
});
