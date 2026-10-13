// src/lib/workshop-certificate-options.ts
//
// Workshop certificates ONLY. Course certificates are set up inside each course.
// Kept free of pdf-lib / qrcode imports so the dashboard page can use it
// without pulling the PDF code into the browser bundle.
// The template ids match CertTemplate in lib/certificate.ts.

export const WORKSHOP_CERT_TEMPLATES = [
  { id: 'classic', label: 'Classic', note: 'White page, navy border, gold touches' },
  { id: 'modern', label: 'Modern', note: 'Dark page with bright accents' },
  { id: 'gold', label: 'Gold', note: 'Ivory page with a gold border' },
  { id: 'minimal', label: 'Minimal', note: 'Clean white page, very simple' },
  { id: 'royal', label: 'Royal', note: 'Deep navy page with gold text' },
] as const

export type WorkshopCertTemplateId = (typeof WORKSHOP_CERT_TEMPLATES)[number]['id']

export const DEFAULT_WORKSHOP_CERT_TEMPLATE: WorkshopCertTemplateId = 'classic'
export const MAX_WORKSHOP_CERT_MESSAGE = 160

export function isWorkshopCertTemplate(v: unknown): v is WorkshopCertTemplateId {
  return WORKSHOP_CERT_TEMPLATES.some(t => t.id === v)
}