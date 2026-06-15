type SendPayslipOptions = {
  to: string;
  staffName: string;
  month: string;
  totalSalary: number;
  pdf: Buffer;
};

type WhatsAppSendResult = {
  messageId?: string;
  skipped?: boolean;
  error?: string;
};

const graphVersion = process.env.WHATSAPP_GRAPH_VERSION || "v20.0";
const graphBaseUrl = `https://graph.facebook.com/${graphVersion}`;

function normalizeWhatsAppNumber(value?: string): string | null {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("0")) {
    const countryCode = String(process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || "94").replace(/\D/g, "");
    return `${countryCode}${digits.slice(1)}`;
  }
  return digits;
}

function assertWhatsAppConfig() {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    return { ready: false, token: "", phoneNumberId: "" };
  }
  return { ready: true, token, phoneNumberId };
}

async function uploadPdf(pdf: Buffer, filename: string, token: string, phoneNumberId: string): Promise<string> {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", "application/pdf");
  form.append("file", new Blob([pdf], { type: "application/pdf" }), filename);

  const response = await fetch(`${graphBaseUrl}/${phoneNumberId}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const body = await response.json() as { id?: string; error?: { message?: string } };
  if (!response.ok || !body.id) {
    throw new Error(body.error?.message || "Could not upload payslip PDF to WhatsApp.");
  }
  return body.id;
}

async function sendDocument(
  mediaId: string,
  filename: string,
  options: SendPayslipOptions,
  token: string,
  phoneNumberId: string
): Promise<string | undefined> {
  const response = await fetch(`${graphBaseUrl}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: options.to,
      type: "document",
      document: {
        id: mediaId,
        filename,
        caption: `Hi ${options.staffName}, your DineFlow salary for ${options.month} has been paid. Total: LKR ${options.totalSalary}. Payslip attached.`,
      },
    }),
  });
  const body = await response.json() as { messages?: Array<{ id?: string }>; error?: { message?: string } };
  if (!response.ok) {
    throw new Error(body.error?.message || "Could not send payslip on WhatsApp.");
  }
  return body.messages?.[0]?.id;
}

export async function sendPayslipToWhatsApp(options: SendPayslipOptions): Promise<WhatsAppSendResult> {
  const config = assertWhatsAppConfig();
  if (!config.ready) {
    return { skipped: true, error: "WhatsApp Cloud API is not configured." };
  }

  const to = normalizeWhatsAppNumber(options.to);
  if (!to) {
    return { skipped: true, error: "Staff WhatsApp number is missing." };
  }

  try {
    const safeName = options.staffName.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "staff";
    const filename = `dineflow-payslip-${safeName}-${options.month}.pdf`;
    const mediaId = await uploadPdf(options.pdf, filename, config.token, config.phoneNumberId);
    const messageId = await sendDocument(mediaId, filename, { ...options, to }, config.token, config.phoneNumberId);
    return { messageId };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not send WhatsApp payslip." };
  }
}
