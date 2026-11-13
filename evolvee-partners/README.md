# Evolvée Radiance Partner Program

Django app in `evolvee-partners/`. Partners apply, get a code and QR, share them, and see commissions. Staff approve people and record payouts.

**Live site:** https://partners.evolveeradiance.com/  
**Apply:** https://partners.evolveeradiance.com/apply/

This is not the Operations Hub. The Hub only reads KPIs from here (`GET /api/ops-hub/summary/`, header `X-Ops-Hub-Key`). Do not merge the two.

## How it works

1. Someone applies. Staff approve them in Django Admin. They get a creator ID, discount code, and QR.
2. They share the QR, the tracking link (`/r/<code>/`), or the discount code.
3. Shopify sends orders here (paid, fulfilled, cancelled, refunded). Django attributes the sale and calculates commission.
4. After fulfilment there is a **30-day hold**. On the **15th**, staff run the monthly payout command, send PayPal or bank outside the app, then mark the payment **Paid**.

Django does not send money. Automated PayPal is Version 2.

## Pages

| Who | URL |
|-----|-----|
| Apply | `/apply/` |
| Partner login / dashboard | `/login/` then `/` |
| Staff login | `/admin/login/` (goes to Command Center) |
| Command Center | `/command-center/` |
| Django Admin | `/admin/` |

## Run locally

```powershell
cd evolvee-partners
py -3.12 -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
py manage.py migrate
py manage.py runserver
```

Then open http://127.0.0.1:8000/login/

## Shopify

Webhooks hit this app on Render. Incoming hooks use the webhook secret (HMAC). They do not need a new Admin API token.

Become a Partner on the main website is a Shopify redirect to `/apply/`. The store theme is separate. Do not publish the live theme from here.

## Notes

- Branch: `consolidated-development`
- Hosted on Render with Postgres. Secrets stay in Render Environment, not in Git.
- Shop domain in env must be `*.myshopify.com`, not evolveeradiance.com.
- Version 1 payout methods are PayPal and bank only.
