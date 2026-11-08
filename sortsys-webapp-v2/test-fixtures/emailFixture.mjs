// Synthetic construction correspondence, including a self-contained raster logo.
export const emailLogo = "iVBORw0KGgoAAAANSUhEUgAAACwAAAAsCAIAAACR5s1WAAAASElEQVR4nO3OwQ0AEBREQR0oUKO6owAJIfkczObdd1Iu9XnpuQACAiIE0YZBQPyDmN9AQECcIbaIEBAQEBAQEBGIa0FAQECs6recTyQpqXuUAAAAAElFTkSuQmCC";
export const richEmailText = "Guten Tag Frau Schneider,\n\ndie Fensterdetails für das Pirckheimer-Gymnasium sind freigegeben. Die abgestimmten Termine stehen in der Übersicht.\n\nMit freundlichen Grüßen\nFrank Müller";
export const richEmailHtml = `<!doctype html><html><head>
<style>@import url(https://tracker.invalid/styles); .remote{background-image:url(https://tracker.invalid/css)}</style>
<link rel="stylesheet" href="https://tracker.invalid/sheet"><base href="https://tracker.invalid/"></head><body>
<p style="font-size:18px;font-weight:700;color:#16477c">Freigabe der Fensterdetails</p>
<p>Guten Tag Frau Schneider,</p>
<p>die Fensterdetails für das <b>Pirckheimer-Gymnasium</b> sind freigegeben.<br>Die abgestimmten Termine stehen in der Übersicht:</p>
<table cellpadding="10" style="width:100%;border-collapse:collapse;font-size:14px">
<tr><th style="background-color:#edf3fa;border-bottom:1px solid #cbd5e1">Leistung</th><th style="background-color:#edf3fa;border-bottom:1px solid #cbd5e1">Termin</th></tr>
<tr><td style="border-bottom:1px solid #e2e8f0">Aufmaß vor Ort</td><td style="border-bottom:1px solid #e2e8f0">12. November, 08:30 Uhr</td></tr>
<tr><td style="border-bottom:1px solid #e2e8f0">Beginn der Fenstersanierung</td><td style="border-bottom:1px solid #e2e8f0">16. November</td></tr></table>
<p style="margin-top:18px">Die Freigabe liegt als Anhang bei. Bei Rückfragen ist die Bauleitung unter <a href="mailto:planung@example.test">planung@example.test</a> erreichbar.</p>
<p>Mit freundlichen Grüßen<br><strong>Frank Müller</strong></p>
<table role="presentation" cellpadding="0"><tr><td style="padding-right:12px"><img src="CID:Logo%40site" width="44" height="44" alt="Musterbau Logo"></td><td><b style="color:#16477c">Musterbau GmbH</b><br><span style="font-size:12px;color:#526174">Bauleitung · Fenstersanierung</span></td></tr></table>
<blockquote><p>Am 5. November schrieb Anna Schneider:</p><p>Bitte die Anschlüsse im Erdgeschoss wie besprochen ausführen. Vielen Dank!</p></blockquote>
<img src="https://tracker.invalid/pixel" width="1" height="1"><img src="//tracker.invalid/relative"><img src="/relative-pixel">
<picture><source srcset="https://tracker.invalid/srcset 2x"><img src="https://tracker.invalid/photo" alt="Baustellenfoto"></picture>
<div style="background:url(https://tracker.invalid/background);position:fixed;inset:0">Freigabe erteilt.</div>
<svg><image href="https://tracker.invalid/svg" /></svg><iframe src="https://tracker.invalid/frame"></iframe>
<script>parent.emailPreviewCompromised=true</script></body></html>`;

export function makeEmlFixture() {
  return [
    'From: "Frank Müller" <frank@example.test>', 'To: "Anna Schneider" <planung@example.test>',
    "Cc: bauleitung@example.test", "Subject: Fensterdetails – Freigabe und Termine",
    "Date: Fri, 06 Nov 2026 10:35:00 +0100", "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="outer"', "", "--outer",
    'Content-Type: multipart/related; boundary="related"', "", "--related",
    'Content-Type: multipart/alternative; boundary="body"', "", "--body",
    "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "",
    Buffer.from(richEmailText).toString("base64"), "--body", "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64", "", Buffer.from(richEmailHtml).toString("base64"), "--body--",
    "--related", "Content-Type: image/png", 'Content-Disposition: inline; filename="logo.png"',
    "Content-ID: <Logo@site>", "Content-Transfer-Encoding: base64", "", emailLogo, "--related--",
    "--outer", "Content-Type: application/pdf", 'Content-Disposition: attachment; filename="Fensterdetails.pdf"',
    "Content-Transfer-Encoding: base64", "", Buffer.from("%PDF-1.7\nSynthetic test attachment.\n").toString("base64"), "--outer--",
  ].join("\r\n");
}
