import { NextRequest, NextResponse } from 'next/server'
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { createClient } from '@/lib/supabase/server'
import { getR2Client, R2_BUCKET, STORAGE_LIMIT_BYTES } from '@/lib/r2'
import { getCorsHeaders } from '@/lib/cors'

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: getCorsHeaders(req.headers.get('origin')) })
}

export async function POST(req: NextRequest) {
  const cors = getCorsHeaders(req.headers.get('origin'))

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: cors })

  const form = await req.formData()
  const file = form.get('file')
  const app = form.get('app')
  const subpath = form.get('subpath')

  if (!(file instanceof File) || typeof app !== 'string' || typeof subpath !== 'string' || !app || !subpath) {
    return NextResponse.json({ error: 'Invalid request: file, app, and subpath are required' }, { status: 400, headers: cors })
  }

  // Quota check: read current usage from the counter in user_secrets.
  const { data: secrets } = await supabase
    .from('user_secrets')
    .select('storage_bytes')
    .eq('user_id', user.id)
    .maybeSingle()

  const used = (secrets?.storage_bytes as number | null) ?? 0
  if (used + file.size > STORAGE_LIMIT_BYTES) {
    return NextResponse.json({ error: 'Storage quota exceeded' }, { status: 403, headers: cors })
  }

  const key = `${user.id}/${app}/${subpath}`
  const bytes = await file.arrayBuffer()

  await getR2Client().send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: Buffer.from(bytes),
    ContentType: file.type || 'application/octet-stream',
  }))

  // Increment counter. Fire-and-forget — a failed increment is corrected the
  // next time the settings page reconciles against the live R2 scan.
  supabase
    .from('user_secrets')
    .upsert({ user_id: user.id, storage_bytes: used + file.size }, { onConflict: 'user_id' })
    .then(() => {})

  const expiresIn = file.type.startsWith('image/') ? 7 * 24 * 3600 : 3600
  const presignedUrl = await getSignedUrl(
    getR2Client(),
    new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }),
    { expiresIn }
  )

  return NextResponse.json({ key, presignedUrl }, { headers: cors })
}
