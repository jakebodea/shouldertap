/** Inline styles and presentation tables survive email clients stripping stylesheets. */
export const accountEmailTemplate = (
  url: string
): {
  html: string;
  text: string;
} => {
  const href = url
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("'", "&#39;");
  return {
    text: [
      "Sign in to your Shouldertap account:",
      "",
      url,
      "",
      "This link expires in 10 minutes and can be used once.",
      "",
      "If you didn't request this email, you can ignore it.",
    ].join("\n"),
    html: `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in to Shouldertap</title></head>
<body style="margin:0;padding:0;background-color:#ebe9e3;color:#161616;font-family:Arial,Helvetica,sans-serif;">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">Your sign-in link is ready. It expires in 10 minutes.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#ebe9e3;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background-color:#2546db;border-radius:28px;">
<tr><td style="padding:28px 28px 24px;color:#ffffff;font-size:26px;font-weight:800;letter-spacing:-1px;">Shouldertap</td></tr>
<tr><td style="padding:0 8px 8px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f6f5f1;border-radius:22px;">
<tr><td style="padding:36px 28px 40px;">
<h1 style="margin:0 0 18px;font-size:36px;line-height:1.12;font-weight:800;letter-spacing:-1.3px;color:#161616;">A little closer.</h1>
<p style="margin:0 0 28px;font-size:17px;line-height:1.55;color:#161616;">Sign in to your Shouldertap account to pick up where you left off.</p>
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="#161616" style="border-radius:999px;text-align:center;"><a href="${href}" style="display:inline-block;padding:16px 24px;border:1px solid #161616;border-radius:999px;color:#ffffff;font-size:16px;font-weight:700;line-height:20px;text-decoration:none;mso-padding-alt:0;"><!--[if mso]><i style="mso-font-width:150%;mso-text-raise:24pt;" hidden>&emsp;</i><![endif]-->Sign in to Shouldertap<!--[if mso]><i style="mso-font-width:150%;" hidden>&emsp;&#8203;</i><![endif]--></a></td></tr></table>
<p style="margin:20px 0 0;font-size:14px;line-height:1.5;color:#6f6e69;">This link expires in 10 minutes<br>and can be used once.</p>
</td></tr>
<tr><td style="padding:24px 28px;border-top:1px solid #dedcd5;"><p style="margin:0;font-size:14px;line-height:1.6;color:#6f6e69;">Didn't ask to sign in? You can ignore this email.</p></td></tr>
</table>
</td></tr></table>
<p style="margin:20px 0 0;font-size:12px;line-height:1.5;color:#6f6e69;">A small tap. A real connection.</p>
</td></tr></table>
</body></html>`,
  };
};
