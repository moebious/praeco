import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const root = fileURLToPath(new URL('../test/fixtures/demo-day/sources/', import.meta.url));
await mkdir(root, { recursive: true });
const inputData = [
  { id: 'BLINKA-01', alias: 'doc-bogota-pdf', number: 'BOG-2026-10', name: 'Synthetic Bogota Developer', tax: 'SYN-TAX-BOG', account: 'SYN-BOG-ACCOUNT-A', amount: '2200.00', currency: 'USD' },
  { id: 'BLINKA-02', alias: 'doc-cloud-pdf', number: 'CLOUD-2026-10', name: 'Synthetic Cloud Infrastructure', tax: 'SYN-TAX-CLOUD', account: 'SYN-CLOUD-ACCOUNT-A', amount: '480.00', currency: 'USD' },
  { id: 'BLINKA-03', alias: 'doc-mexico-pdf', number: 'MEX-2026-10', name: 'Synthetic Mexico Design Agency', tax: 'SYN-TAX-MEX', account: 'SYN-MEX-ACCOUNT-A', amount: '76000.00', currency: 'MXN' },
  { id: 'BLINKA-04', alias: 'doc-argentina-pdf', number: 'ARG-2026-10', name: 'Synthetic Argentina Contractor', tax: 'SYN-TAX-ARG', account: 'SYN-ARG-ACCOUNT-A', amount: '1950.00', currency: 'USD' },
  { id: 'BLINKA-05', alias: 'msg-bogota-forward', number: 'BOG-2026-10', name: 'Synthetic Bogota Developer', tax: 'SYN-TAX-BOG', account: 'SYN-BOG-ACCOUNT-A', amount: '2200.00', currency: 'USD' },
  { id: 'BLINKA-06', alias: 'doc-new-vendor-cop', number: 'COP-NEW-2026-10', name: 'Synthetic Colombia Contractor', tax: 'SYN-TAX-CO', account: 'SYN-CO-ACCOUNT-A', amount: '2400000.00', currency: 'COP' },
  { id: 'BLINKA-07', alias: 'doc-over-budget', number: 'BUDGET-2026-10', name: 'Synthetic Services Contractor', tax: 'SYN-TAX-BUDGET', account: 'SYN-BUDGET-ACCOUNT-A', amount: '2100.00', currency: 'USD' },
  { id: 'BLINKA-08', alias: 'doc-changed-account', number: 'ACCOUNT-2026-10', name: 'Synthetic Regional Supplier', tax: 'SYN-TAX-ACCOUNT', account: 'SYN-ACCOUNT-REPLACEMENT-B', amount: '1200.00', currency: 'USD' },
];
const sources: { scenarioId: string; sourceAlias: string; file: string; channel: string; mimeType: string; purpose: string }[] = [];
for (const [index, input] of inputData.entries()) {
  const text = `${index === 4 ? 'Forwarded body snapshot\n' : ''}SYNTHETIC INVOICE - NO REAL COMPANY OR PAYMENT
Invoice number: ${input.number}
Issue date: 2026-10-01
Due date: 2026-10-31
Period start: 2026-10-01
Period end: 2026-10-31
Beneficiary: ${input.name}
Tax ID: ${input.tax}
Payment rail: BANK
Account: ${input.account}
Contract: SYN-CONTRACT-${index === 4 ? '1' : index + 1}
Description: Synthetic monthly services
Currency: ${input.currency}
Subtotal: ${input.amount}
Taxes: 0
Discounts: 0
Total due: ${input.amount}
Already paid: 0
Outstanding balance: ${input.amount}
`;
  const file = `${String(index + 1).padStart(2, '0')}.${index === 4 ? 'txt' : 'pdf'}`;
  if (index === 4) await writeFile(join(root, file), text);
  else {
    const pdf = await PDFDocument.create();
    pdf.setCreationDate(new Date('2026-10-17T00:00:00Z')); pdf.setModificationDate(new Date('2026-10-17T00:00:00Z'));
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([612, 792]);
    for (const [lineIndex, line] of text.split('\n').entries()) page.drawText(line, { x: 36, y: 752 - lineIndex * 24, size: 11, font });
    await writeFile(join(root, file), await pdf.save());
  }
  sources.push({ scenarioId: input.id, sourceAlias: input.alias, file, channel: index === 4 ? 'EMAIL' : 'PDF', mimeType: index === 4 ? 'text/plain' : 'application/pdf', purpose: 'PRIMARY_INVOICE' });
}
for (const context of [
  { id: 'BLINKA-02', alias: 'msg-cloud-email', channel: 'EMAIL', file: '02-context.txt', text: 'Supplemental context\nReference: CLOUD-2026-10\nThis message accompanies the separate monthly services invoice. Keep the attachment as the primary invoice source.' },
  { id: 'BLINKA-04', alias: 'msg-argentina-chat', channel: 'CHAT', file: '04-context.txt', text: 'Supplemental context\nReference: ARG-2026-10\nThe separate PDF requests USD 1950, including a proposed USD 450 bonus over a USD 1500 base. This informal proposal is not an approved contract amendment.' },
]) {
  await writeFile(join(root, context.file), context.text);
  sources.push({ scenarioId: context.id, sourceAlias: context.alias, file: context.file, channel: context.channel, mimeType: 'text/plain', purpose: 'SUPPLEMENTAL_CONTEXT' });
}
await writeFile(join(root, 'index.json'), JSON.stringify({ description: 'Synthetic input inventory only. No expected decisions or authoritative policy state.', sources }, null, 2) + '\n');
console.log(`Generated ${sources.length} synthetic sources for eight original scenarios.`);
