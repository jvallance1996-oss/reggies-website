# Microsoft 365 notification setup

Use `jack@reggies.com.au` as the sending mailbox and notification recipient. The website sends with an application identity; it does not store Jack's Microsoft password, enable SMTP basic authentication, or need access to read his mailbox.

## Required deployment settings

Set these in DigitalOcean's environment settings, using its secret-value controls for the app secret, database connection and private inbox password:

```dotenv
MAIL_PROVIDER=microsoft-graph
MS_TENANT_ID=<Microsoft tenant GUID>
MS_CLIENT_ID=<application client GUID>
MS_CLIENT_SECRET=<application secret value>
MAIL_FROM=jack@reggies.com.au
QUOTE_TO=jack@reggies.com.au
ADMIN_PASSWORD=<your own private enquiry inbox password>
PUBLIC_ORIGIN=https://reggies.com.au
```

`NODE_ENV=production` and the existing `DATABASE_URL`/database TLS settings are also required. Never add actual secret values to this file, GitHub, a pull request or application logs. The app secret is the secret **value**, not its ID. Record its expiry and rotate it in the hosting environment before it expires. The private enquiry inbox uses username `jack` with the separate `ADMIN_PASSWORD`; it is not a Microsoft login.

## Microsoft administration

Register a dedicated single-tenant application. Authorise only the application sending capability needed for `POST /users/jack@reggies.com.au/sendMail`. The Graph application permission for this operation is `Mail.Send`; no `Mail.ReadWrite` or mailbox-reading permission is used. An authorised tenant administrator must review and approve the chosen grant. [Microsoft sendMail permissions](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0)

Scope the application to Jack's mailbox using Exchange Online's supported application access controls. Application RBAC grants and Entra grants are independent: adding a scoped RBAC assignment does not narrow a separately granted tenant-wide Entra permission. Have the tenant administrator configure and test the effective scope, including a mailbox that should be denied. [Exchange application RBAC](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac)

The server exchanges its client ID and secret over HTTPS for a Graph token using the client-credentials flow. Tokens are cached in memory and refreshed before expiry. Fixed Microsoft endpoints, rejected redirects, request deadlines and redacted errors keep credentials out of logs and unrelated requests. No Graph SDK dependency is required. [Microsoft app-only authentication](https://learn.microsoft.com/en-us/graph/auth-v2-service)

## Photos and notifications

Graph notifications contain the enquiry details and authenticated links to `/admin/quotes` and each uploaded original photo. All four photos, including maximum-size uploads, remain in the durable database. The email does not attach photo bytes. This avoids the draft/upload-session workflow for large attachments, which would require `Mail.ReadWrite`. The private inbox password and HTTPS origin are therefore mandatory in Graph mode. [Microsoft large attachment workflow](https://learn.microsoft.com/en-us/graph/outlook-large-attachments)

The durable notification worker handles failures and provider throttling without deleting the saved enquiry. A Graph 202 means Microsoft accepted the request; inbox delivery still needs verification. `Retry-After` delays are respected within a 24-hour bound. [Graph throttling guidance](https://learn.microsoft.com/en-us/graph/throttling)

## Verification before release

Confirm the tenant grant and host settings, then run one clearly labelled, authorised test enquiry through the deployed website. Check that it appears in the private inbox, its protected photo links require authentication, the originals open after signing in, and the notification actually arrives in `jack@reggies.com.au`. Confirm the request reference matches the email and the database status. Unit tests mock Microsoft and cannot prove tenant consent or inbox delivery.

SMTP remains available by setting `MAIL_PROVIDER=smtp` (the default), configuring the existing `SMTP_*` settings plus `QUOTE_TO`, and using its verified sender. SMTP notifications continue to attach the original photos. No changes to customer form fields are needed when switching providers.
