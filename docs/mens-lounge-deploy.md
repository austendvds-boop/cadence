# Men's Lounge Barbershop — Cadence Deploy

Date: 2026-03-05
Tenant: mens-lounge
Twilio Number: +16232536931
Forward-to: +16235563193 (Norterra — placeholder until owner confirms)
Railway URL: https://cadence-v2-production.up.railway.app
DB: Neon Postgres (Railway env)

Deployed by: Steve via Cadence v2 multi-tenant system

## Verification
- Tenant row exists in `clients` with:
  - `tenant_key = mens-lounge`
  - `business_name = Men's Lounge Barbershop`
  - `greeting = Hey, thanks for calling Men's Lounge Barbershop! How can I help you?`
  - `timezone = America/Phoenix`
  - `transfer_number = +16235563193`
  - `phone_number = +16232536931`
  - `twilio_number_sid = PN39a6da3415714669881e3b19563f197f`
- Twilio webhook check passed:
  - `voice_url = https://cadence-v2-production.up.railway.app/incoming-call`
  - `voice_method = POST`
- Existing tenant safety check passed:
  - DVDS tenant (`tenant_key = dvds`) still mapped to `phone_number = +18773464394`
