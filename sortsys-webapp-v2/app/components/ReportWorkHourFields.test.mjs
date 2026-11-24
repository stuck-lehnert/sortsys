import assert from "node:assert/strict";
import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MyForm } from "./MyForm";

globalThis.__SORTSYS_REVISION__ ??= "ui-test";
const { ReportWorkHourFields } = await import("./ReportWorkHourFields");

function renderRow(props, weekday) {
  return renderToStaticMarkup(
    createElement(
      MyForm,
      null,
      createElement(
        ReportWorkHourFields,
        {
          fieldPrefix: "workHour:example",
          focusEmployee: false,
          numberRule: "posnum",
          onRemove() {},
          ...props,
        },
        weekday,
      ),
    ),
  );
}

test("report hours show the employee picker, hours and removal", () => {
  const form = renderRow({ focusHoursOnSelect: true });

  assert.match(form, /Mitarbeiter|Employee/);
  assert.match(form, /type="number"/);
  assert.match(form, /aria-label="(?:Arbeitszeit entfernen|Remove work-hours entry)"/);
  assert.equal((form.match(/<input\b/g) ?? []).length, 2);
});

test("unavailable employees keep an editable hours field without a picker", () => {
  for (const unavailableEmployee of ["Nicht freigegeben", "Ohne Zuordnung"]) {
    const form = renderRow({ unavailableEmployee });

    assert.match(form, new RegExp(unavailableEmployee));
    assert.match(form, /type="number"/);
    assert.equal((form.match(/<input\b/g) ?? []).length, 1);
  }
});

test("the optional weekday field comes before the employee and hours", () => {
  const weekday = createElement("select", { "aria-label": "Weekday" });
  const form = renderRow({ numberRule: "num" }, weekday);

  assert.match(form, /<select[^>]*aria-label="Weekday".*<input.*type="number"/);
});
