import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { stampEbookPdf } from '@/lib/ebook-pdf'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/** Takes one download slot atomically: the update only succeeds if nobody else changed the count first. */
async function claimDownload(id: string, limit: number): Promise<boolean> {
  for (let i = 0; i < 5; i++) {
    const { data: cur } = await supabase.from('transactions').select('ebook_download_count').eq('id', id).single()
    if (!cur || cur.ebook_download_count >= limit) return false
    const { data: won } = await supabase
      .from('transactions')
      .update({ ebook_download_count: cur.ebook_download_count + 1 })
      .eq('id', id)
      .eq('ebook_download_count', cur.ebook_download_count)
      .select('id')
    if (won && won.length) return true
  }
  return false
}

export async function GET(req: NextRequest) {
  const purchaseId = req.nextUrl.searchParams.get('purchaseId')
  if (!purchaseId) return NextResponse.json({ error: 'Missing purchaseId' }, { status: 400 })

  const { data: purchase, error } = await supabase
    .from('transactions')
    .select('id, status, ebook_id, student_name, student_email, ebook_download_count, ebook_download_limit')
    .eq('id', purchaseId)
    .eq('product_type', 'ebook')
    .maybeSingle()

  if (error || !purchase) return NextResponse.json({ error: 'Purchase not found' }, { status: 404 })
  if (purchase.status !== 'success') return NextResponse.json({ error: 'Payment not confirmed yet' }, { status: 402 })
  if (purchase.ebook_download_count >= purchase.ebook_download_limit) {
    return NextResponse.json({ error: 'Download limit reached. Contact the creator to reset it.' }, { status: 403 })
  }

  const { data: ebook } = await supabase.from('ebooks').select('title, pdf_storage_path').eq('id', purchase.ebook_id).maybeSingle()
  if (!ebook) return NextResponse.json({ error: 'Ebook not found' }, { status: 404 })

  const { data: fileBlob, error: downloadError } = await supabase.storage.from('ebook-files').download(ebook.pdf_storage_path)
  if (downloadError || !fileBlob) return NextResponse.json({ error: 'Could not load the file' }, { status: 500 })

    if (!(await claimDownload(purchase.id, purchase.ebook_download_limit))) {
    return NextResponse.json({ error: 'Download limit reached. Contact the creator to reset it.' }, { status: 403 })
  }  
  const sourceBytes = new Uint8Array(await fileBlob.arrayBuffer())
  const stamped = await stampEbookPdf(sourceBytes, {
    buyerName: purchase.student_name || 'Reader',
    buyerEmail: purchase.student_email || '',
    orderId: purchase.id,
  })

    await supabase.from('transactions').update({ ebook_download_count: purchase.ebook_download_count + 1 }).eq('id', purchase.id)
  await supabase.from('ebook_downloads').insert({ purchase_id: purchase.id, ip_address: req.headers.get('x-forwarded-for') || null })

  return new NextResponse(Buffer.from(stamped), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${ebook.title.replace(/[^a-z0-9]/gi, '_')}.pdf"`,
      'Cache-Control': 'no-store',
    },
  })
}