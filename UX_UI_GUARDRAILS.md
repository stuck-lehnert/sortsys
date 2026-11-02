# UX/UI guardrails

Apply these rules to every webapp route, shared component and dialog.

- Use HeroUI components and their interaction behavior. Use Tailwind utilities for
  layout and shared theme tokens for appearance. Keep custom CSS to product-specific
  layouts, document viewers and the loading cube; remove superseded control styles.
- Organize screens around the user's task. Show a clear page title, current location
  and primary action. Group related information and keep secondary actions quieter.
  Preserve permissions, shortcuts, saved work and browser navigation behavior.
- Use consistent spacing, typography and content widths. Support narrow screens and
  200% zoom without page-wide horizontal scrolling. Give dense tables a labeled,
  contained scrolling area and keep essential row actions reachable. Use a
  “Mehr anzeigen” / “Show more” button for listing batches. Retain visible results
  and reset the batch when filters or sorting change.
- Write concise labels that describe the action or result. Keep terminology stable.
  Give fields persistent labels, useful examples and explicit units where needed.
  Localize visitor-facing text in German and English using the existing helpers.
- Keep forms focused on the current task. Preserve entered values after errors,
  associate messages with their fields and focus the first invalid field on submit.
  Explain how to recover. Confirm destructive actions and prevent duplicate submits.
- Distinguish loading, empty, success and failure states. Announce important changes
  without moving focus unnecessarily. Provide retry actions for recoverable failures.
  Optional editors must not block the rest of the app during startup or recovery.
- Support keyboard use throughout. Use semantic links, buttons and headings; give
  icon-only controls accessible names. Keep focus visible and unobscured. Dialogs
  trap focus, close predictably and restore focus to their trigger, including nesting.
- Aim for WCAG 2.2 AA. Check text and control contrast in light and dark themes;
  never communicate state through color alone. Prefer 44 CSS-pixel touch targets;
  dense controls must meet WCAG's target-size or spacing requirements. Respect
  reduced-motion preferences and avoid hover-only access to essential actions.
- Use icons when they identify content, state or an otherwise unlabeled action.
  Keep decorative icons out of text-labeled menus. Keep the visual hierarchy calm
  and use the same interaction patterns across ordinary and administrator screens.
- Before completion, review every route and its loading, empty, populated and error
  states. Run maintained tests, full typecheck and production build. Check actual
  desktop and mobile layouts, both languages and themes, keyboard navigation,
  dialogs, forms and representative permission-restricted workflows in a browser.

## References

Platform-specific dimensions and APIs need adaptation to the web. Use the web
accessibility references below when platform advice differs.

- [Google Interactive Canvas design][canvas]
- [Google UI elements and interaction][google-ui]
- [Apple Human Interface Guidelines][hig]
- [Microsoft UI content recommendations][content]
- [Microsoft app best practices][windows]
- [Apple design tips][tips]
- [HeroUI components and documentation][heroui]
- [WCAG 2.2][wcag]
- [WAI-ARIA Authoring Practices Guide][apg]

[canvas]: https://developers.google.com/assistant/interactivecanvas/design
[google-ui]: https://developers.google.com/style/ui-elements
[hig]: https://developer.apple.com/design/human-interface-guidelines/
[content]: https://learn.microsoft.com/en-us/power-platform/well-architected/experience-optimization/user-interface-content
[windows]: https://learn.microsoft.com/en-us/windows/apps/get-started/best-practices
[tips]: https://developer.apple.com/design/tips/
[heroui]: https://github.com/heroui-inc/heroui
[wcag]: https://www.w3.org/TR/WCAG22/
[apg]: https://www.w3.org/WAI/ARIA/apg/
