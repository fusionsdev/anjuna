const PII_KEY_DENYLIST = new Set([
  "first_name", "last_name", "full_name", "name",
  "email", "phone", "telephone", "mobile",
  "address", "street", "city", "postal_code", "zip",
  "date_of_birth", "dob", "ssn", "social_security_number",
  "driver_license", "income", "employment", "employer",
  "bank", "bank_name", "bank_account", "account_number", "routing_number",
  "password", "authorization", "cookie", "set-cookie",
  "form_data", "form_values", "request_body", "response_body", "payload",
  "trustedform", "xxtrustedformcerturl", "trustedform_cert_url", "certificate_url",
  "raw_query_string", "gclid", "gbraid", "wbraid", "msclkid", "fbclid",
  // Lead fields
  "first name", "last name", "birth date", "birth_date", "home phone", "work phone",
  "lead_id", "home_phone", "work_phone",
]);

const PII_KEY_PATTERN =
  /^(first|last|full|given|sur|family|middle)[\s_-]?name$|^(birth[\s_-]?date|dob|sin|social)$|^(pass(?:word)?|pwd|secret|auth|credential|bearer|api[\s_-]?key)$|^(phone|tel|mobile|cell)$|^e?mail$|^(zip|postal)$|^routing[\s_-]?(?:number|num)?$|^account[\s_-]?(?:number|num)?$/i;

export function sanitizeKeys(obj: Record<string, unknown>): Record<string, unknown> {
  if (!obj || typeof obj !== "object") return obj;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (PII_KEY_DENYLIST.has(k.toLowerCase()) || PII_KEY_PATTERN.test(k)) continue;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      out[k] = sanitizeKeys(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function stripSensitivePatterns(s: string): string {
  return s
    .replace(/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g, "[email]")
    .replace(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, "[phone]")
    .replace(/\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/g, "[ssn]")
    .replace(/\b4\d{15}\b|\b5[1-5]\d{14}\b|\b3[47]\d{13}\b/g, "[card]");
}
