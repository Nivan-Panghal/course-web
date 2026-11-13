import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAuthenticatedCreator } from '@/app/api/razorpay/subscription-auth'
import { friendlyErrorResponse } from '@/lib/payment-errors'
import { isImpersonationActive, IMPERSONATION_BLOCK_MESSAGE } from '@/lib/impersonation-guard'
import {
  GatewayProvider,
  GatewayVerificationError,
  verifyGatewayCredentials,
  encryptCredentials,
} from '@/lib/payment-gateways'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const VALID_PROVIDERS: GatewayProvider[] = ['cashfree', 'razorpay', 'stripe']

// GET — list all gateways connected for this creator (no secrets returned)
export async function GET(req: NextRequest) {
  try {
    const { creator, error } = await getAuthenticatedCreator(req)
    if (error || !creator) return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 })
    if (await isImpersonationActive(creator.id)) {
      return NextResponse.json({ error: IMPERSONATION_BLOCK_MESSAGE }, { status: 403 })
    }

    const { data, error: dbError } = await supabase
      .from('creator_payment_gateways')
      .select('provider, environment, status, last_verification_error, verified_at, is_default, updated_at')
      .eq('creator_id', creator.id)
    if (dbError) throw dbError

    return NextResponse.json({ gateways: data || [] })
  } catch (err: any) {
    return friendlyErrorResponse(err, 'payment-gateway GET')
  }
}

// POST — save + live-verify one provider's credentials. Never saves
// unverified credentials as "verified" — status only flips to verified
// after a real API call to the provider succeeds.
export async function POST(req: NextRequest) {
  try {
    const { creator, error } = await getAuthenticatedCreator(req)
    if (error || !creator) return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 })
    if (await isImpersonationActive(creator.id)) {
      return NextResponse.json({ error: IMPERSONATION_BLOCK_MESSAGE }, { status: 403 })
    }

    const body = await req.json()
    const provider = body.provider as GatewayProvider
    const environment = body.environment === 'sandbox' ? 'sandbox' : 'production'
    const credentials = body.credentials || {}
    const webhookSecret = typeof body.webhookSecret === 'string' ? body.webhookSecret.trim() : ''
    const setDefault = !!body.setDefault

    if (!VALID_PROVIDERS.includes(provider)) {
      return NextResponse.json({ error: 'Unknown payment provider.' }, { status: 400 })
    }

    // Live verification BEFORE anything is saved. If this throws
    // GatewayVerificationError, the creator gets an exact reason —
    // no silent failure, no "saved but broken" state.
    try {
      await verifyGatewayCredentials(provider, credentials, environment)
    } catch (verifyErr: any) {
      if (verifyErr instanceof GatewayVerificationError) {
        // Log the failed attempt so status isn't just silently absent
        await supabase.from('creator_payment_gateways').upsert(
          {
            creator_id: creator.id,
            provider,
            environment,
            credentials_encrypted: encryptCredentials(credentials),
            webhook_secret_encrypted: webhookSecret ? encryptCredentials({ secret: webhookSecret }) : null,
            status: 'failed',
            last_verification_error: verifyErr.message,
          },
          { onConflict: 'creator_id,provider' }
        )
        return NextResponse.json({ error: verifyErr.message }, { status: 400 })
      }
      // Network / provider-outage failure — don't tell the creator their
      // key is wrong when it might just be a transient issue.
      throw verifyErr
    }

    if (setDefault) {
      await supabase
        .from('creator_payment_gateways')
        .update({ is_default: false })
        .eq('creator_id', creator.id)
    }

    // Re-saving a gateway (e.g. rotating its key) must never silently drop its default flag.
    const { data: existingRow } = await supabase
      .from('creator_payment_gateways')
      .select('is_default')
      .eq('creator_id', creator.id)
      .eq('provider', provider)
      .maybeSingle()
    const existingIsDefault = !!existingRow?.is_default

    const { error: upsertError } = await supabase.from('creator_payment_gateways').upsert(
      {
        creator_id: creator.id,
        provider,
        environment,
        credentials_encrypted: encryptCredentials(credentials),
        webhook_secret_encrypted: webhookSecret ? encryptCredentials({ secret: webhookSecret }) : null,
        status: 'verified',
        last_verification_error: null,
        verified_at: new Date().toISOString(),
        is_default: setDefault || existingIsDefault,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'creator_id,provider' }
    )
    if (upsertError) throw upsertError

    return NextResponse.json({ success: true, status: 'verified' })
  } catch (err: any) {
    return friendlyErrorResponse(err, 'payment-gateway POST')
  }
}

// DELETE — disconnect a provider (?provider=cashfree)
export async function DELETE(req: NextRequest) {
  try {
    const { creator, error } = await getAuthenticatedCreator(req)
    if (error || !creator) return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 })
    if (await isImpersonationActive(creator.id)) {
      return NextResponse.json({ error: IMPERSONATION_BLOCK_MESSAGE }, { status: 403 })
    }

    const provider = req.nextUrl.searchParams.get('provider') as GatewayProvider
    if (!VALID_PROVIDERS.includes(provider)) {
      return NextResponse.json({ error: 'Unknown payment provider.' }, { status: 400 })
    }

    const { error: deleteError } = await supabase
      .from('creator_payment_gateways')
      .delete()
      .eq('creator_id', creator.id)
      .eq('provider', provider)
    if (deleteError) throw deleteError

    return NextResponse.json({ success: true })
  } catch (err: any) {
    return friendlyErrorResponse(err, 'payment-gateway DELETE')
  }
}
