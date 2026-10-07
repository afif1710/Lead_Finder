# Lead Finder email pilot

An on-demand local workflow for the existing 100 US Google Maps leads: search Snov.io by business name, keep the emails Snov returns, prepare profession-specific website pitches, and send a first batch of at most ten individual emails from **Afif <craftedwebstudio@gmail.com>**. It stops after this batch for the user to check Gmail Sent and handle replies.

This folder is separate from the Maps extension. No extension reload is needed for these scripts, and the extension does not use your email credentials. This pilot does not collect new Maps leads or schedule recurring jobs. New batches and additional Maps collection are a later step after the first batch has been checked.

## Requirements

- Node.js 22 or newer; the scripts use built-in Node modules and need no new npm dependencies.
- The processed source file in `csv_exports/processed/usa_100_unique_no_website_leads_2026-10-07.csv`.
- Snov.io API permission, Client ID, Client Secret, and sufficient account credits. Seeing credentials does not guarantee every API method is available; the first API call checks access and balance.
- A valid physical postal address. Your current home street address is acceptable; a business registration is not required. It appears in outgoing commercial emails. A short reply-based opt-out is included. See the [FTC guidance](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business).
- A Google Desktop OAuth client in your own project, followed by manual Google authorization for the corrected sender account.

## Set up local settings

Run commands from the project root, `E:\Lead_Finder`:

```sh
node automation/cli.mjs init
node automation/cli.mjs setup
```

Open the displayed local URL in Edge. Enter your postal address and Snov API credentials from [Snov API settings](https://app.snov.io/account/api). You can leave the Google JSON upload empty until it is ready. Click **Save local settings**. The local setup listener closes after saving or fifteen minutes; rerun setup if it expires. Its private session file preserves the same local address and verification token across restarts, so a still-open form can be saved again without retyping credentials. A connection failure now identifies the stopped setup session separately from a malformed Google JSON file. Keep the form tab open until saving succeeds.

Settings are stored under `automation/.local/`, which is excluded from Git. The setup page never displays saved credentials and never sends an email. Do not paste passwords, OAuth tokens, or API secrets into a chat. Editing `.local/config.json` and `.local/snov-credentials.json` locally is also supported. Relative paths in config are resolved from `.local/`.

## Collect emails and prepare the first batch

```sh
node automation/cli.mjs status
node automation/cli.mjs discover
node automation/cli.mjs prepare
```

Discovery authenticates with Snov and reads the current credit balance before any business search. Each business name is resolved through documented Snov API methods. The company-name Database Search route checks page one when domain resolution provides no usable contacts; a missing domain alone does not prove Snov has no email. Both routes are recorded, and previously saved domain-only results can use the new database route without submitting another paid name lookup. Returned company metadata must agree with the Maps business; conflicting phones and ambiguous name/location matches are set aside for review. No email address is guessed or constructed. All returned candidates within the provider's bounded page limit are saved; only matched emails marked valid by Snov can enter the send batch. Invalid and unknown email statuses remain in the local results for reference.

This pilot uses the user's selected criterion **no website listed on Google Maps**. A Snov domain can reveal a site that Maps did not list; it is recorded as evidence, and website functionality is not scanned. The pitch does not claim the recipient has no website anywhere. Review business fit before extending outreach.

The local results file is `.local/collected-emails.json`, organized by business with phone, category, address/location, Maps link, Snov company evidence, email status, and lookup outcome. `.local/pilot-preview.json` contains the exact proposed recipients, subjects, and bodies. Preparing a batch sends nothing. Rerun prepare after changing sender details, recipients, or suppression history; edited or stale previews are rejected.

The first email uses the actual Maps category, services, projects/products, testimonials, contact details, an invitation to reply, and an optional free demo. It contains no pricing, upfront-payment terms, backend/database promises, invented compliments, tracking pixels, or automated follow-ups. Instagram is included as supplied.

## Connect Gmail

1. Sign into [Google Cloud Console](https://console.cloud.google.com/) using `craftedwebstudio@gmail.com` and create/select your own project.
2. Enable **Gmail API** in that project.
3. Configure **Google Auth platform** / OAuth consent for personal use. For an external app in testing, add `craftedwebstudio@gmail.com` as a test user.
4. Create an OAuth client with application type **Desktop app**, and download its client JSON. Do not create a service-account key or Web application client for this workflow.
5. Upload that JSON through the local setup page, or save it as `.local/google-desktop-client.json`.
6. Run the command below, open its Google permission URL yourself, select the corrected Gmail account, and approve the requested permissions.

```sh
node automation/cli.mjs authorize
```

Authorization asks for Gmail sending and minimal account-email identification (`gmail.send`, `openid`, `email`). It verifies that you chose `craftedwebstudio@gmail.com`; it does not grant inbox access or handle replies. The callback is local to `127.0.0.1` and waits at most three minutes. Refresh tokens stay in `.local/gmail-auth.json`. If testing-mode authorization expires or permission is revoked, rerun authorize; do not share your Google password. See [Google Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app), [Gmail permissions](https://developers.google.com/workspace/gmail/api/auth/scopes), and [sending messages](https://developers.google.com/workspace/gmail/api/guides/sending).

## Send the first batch, then stop

After the lookup, sender details, Google authorization, and preview are ready:

```sh
node automation/cli.mjs send
node automation/cli.mjs status
```

The send command submits one message per business, at most ten in total, with an eight-second pause by default. If fewer than ten valid contacts exist, it sends only those available and stops. It closes the pilot after this first batch; rerunning send cannot send the remaining contacts. The user checks Gmail Sent, verifies the delivery details, and handles all replies. Only an explicit later instruction should enable another batch.

Confirmed Gmail message IDs and outcomes are saved in `.local/history.json` and `.local/pilot-results.json`. A successful API response confirms Gmail accepted the message; it does not prove inbox delivery or a reply.

Record an opt-out locally when the user receives one:

```sh
node automation/cli.mjs suppress address@example.com
```

Suppression covers both the email and the associated business when it can be matched. No automated reply or follow-up is sent.

## Limits and recovery

- At most 100 source businesses, 500 Snov requests, 50 reserved Snov credits or the available balance (whichever is lower), and thirty minutes per discovery run. A task is polled at most six times with bounded backoff; requests and authentication have timeouts. A private request log records only operation, response status, and duration, without credentials or response bodies. Credentials accepted by the token endpoint do not prove a plan permits every search endpoint; access denials are reported separately from missing emails.
- Snov is paced below its documented 60-request/minute limit. Authentication, access denial, rate limits, exhausted credits, unexpected responses, and timeouts stop discovery and preserve results.
- Completed business lookups are reused. A lookup interrupted after starting a paid task is marked for review and is not automatically resubmitted after a restart. Do not reset its status merely to retry a potentially billed task.
- A lock blocks concurrent runs. After a crash, examine `.local/run.lock` and confirm its PID is no longer running before removing that one stale lock. Do not delete history or the whole local folder.
- A send reservation is written **before** the Gmail request. Reserved, failed, and unknown outcomes all block repeat sends to that business/email. A timeout may mean Gmail accepted the message, so ambiguous sends are never retried automatically.
- Any send failure closes the pilot for review. Check Gmail Sent using the recipient and timestamp before considering manual recovery.
- Keep a private backup of `.local/history.json` and `history-initialized.json`. Missing or damaged history blocks sending. Changing phone numbers, duplicate Maps places, shared mailboxes, and repeated business names/locations are handled conservatively.
- The first batch is a live validation step, not a promise of responses. Do not mark the automation validated until real Snov lookup and the ten-email pilot have been inspected.

## Files and version control

| File or folder | Purpose |
| --- | --- |
| `cli.mjs`, `lib/`, `tests/`, `config.example.json` | Versioned workflow source and mocked tests |
| `.local/config.json` | Private sender details and limits |
| `.local/snov-credentials.json` | Private API credentials |
| `.local/google-desktop-client.json`, `.local/gmail-auth.json` | Private Google client and authorization |
| `.local/collected-emails.json`, `.local/pilot-preview.json` | Private contacts and drafted batch |
| `.local/history.json`, `.local/history-initialized.json`, `.local/pilot-results.json` | Private progress, deduplication, and send history |

Never commit runtime data, credentials, postal addresses, browser profiles, downloads, or token files. The versioned example intentionally has an empty postal address and no credentials. The extension release ZIP contains extension files; use the repository checkout for the separate automation.

## Checks

```sh
node --test automation/tests/*.test.mjs
```

Tests use fake service responses and temporary local files. They do not search real Snov contacts, consume credits, authorize a real Google account, or send email. They cover the ten-message cap, once-per-business/email history, interrupted paid searches, ambiguous sends, corrupted history, suppression, stale previews, exact sender identity, OAuth state/PKCE, limits, and local setup request protection.
