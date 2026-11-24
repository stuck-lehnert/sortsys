import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { AttrList } from "./AttrList";
import { ContactDetailsList } from "./ContactDetailsList";

function renderDetails(props, child) {
  return renderToStaticMarkup(createElement(
    MemoryRouter,
    null,
    createElement(ContactDetailsList, props, child),
  ));
}

test("contact methods keep their labels and links alongside a role and address", () => {
  const html = renderDetails({
    address: { streetAddress: "Markt 1", zip: "10115", city: "Berlin", country: "DE" },
    details: {
      emailAddresses: [
        { email: "office@example.test", name: "Büro" },
        { email: "site@example.test", name: null },
      ],
      phoneNumbers: [{ number: "+49 12345", name: null }],
    },
  }, createElement(AttrList.Attr, { name: "Rolle", value: "Bauleitung" }));

  expect(html).toContain("Bauleitung");
  expect(html).toContain('href="https://www.google.com/maps/search/Markt%201%2C%2010115%20Berlin"');
  expect(html).toContain("Büro");
  expect(html).toMatch(/E-Mail 2|Email 2/);
  expect(html).toMatch(/Telefon 1|Phone 1/);
  expect(html).toContain('href="mailto:office@example.test"');
  expect(html).toContain('href="mailto:site@example.test"');
  expect(html).toContain('href="tel:+49 12345"');
});

test("no address or contact methods leave no empty attribute grid", () => {
  expect(renderDetails({
    details: { emailAddresses: [], phoneNumbers: [] },
  })).toBe("");
});
