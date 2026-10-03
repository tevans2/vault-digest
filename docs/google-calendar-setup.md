# Google Calendar setup

The plugin signs in to Google with your own OAuth client, so no password or secret ever passes through anyone else. This takes about ten minutes, once.

## Part 1: Google Cloud

1. **Create a project** at [console.cloud.google.com](https://console.cloud.google.com) and select it.
2. **Enable the API.** APIs & Services → Library → *Google Calendar API* → Enable.
3. **Set up the app.** Open *Google Auth Platform* and press *Get started*. Choose **External** audience, give the app a name, a support email and a contact email.
4. **Branding.** Fill in:
   - **Application home page:** your GitHub Pages site, for example `https://YOURNAME.github.io/vault-digest/`
   - **Privacy policy link:** `https://YOURNAME.github.io/vault-digest/privacy.html`
   - **Authorized domains:** `YOURNAME.github.io`

   The two pages are in [`docs/`](.). Before publishing the site, replace `YOUR_EMAIL_ADDRESS` in both files and `REPLACE_WITH_DATE` in the privacy page. The homepage must link to the privacy policy, and the app name must match the homepage heading.
5. **Data access.** Add the scopes:
   - `https://www.googleapis.com/auth/calendar.events`
   - `https://www.googleapis.com/auth/calendar.calendarlist.readonly`
6. **Audience → Publish app**, so the status becomes *In production*. While an app stays in *Testing*, Google expires the sign-in every 7 days. For personal use you don't need Google's verification, but sign-in will show an "unverified app" warning (choose *Advanced*, then continue).
7. **Clients → Create client.** Application type **Desktop app**. Copy the client id and secret straight away: Google shows the secret only once.

## Part 2: Obsidian

1. Settings → Vault Digest → Google Calendar.
2. For *Google client id* and *Google client secret*, create two secrets named `google-client-id` and `google-client-secret` and paste the values.
3. Press **Connect**, approve access in the browser, and wait for the "Connected" page.
4. Leave the mode on **Manual** to start: *Preview* shows exactly what would change, and *Sync* applies it.

## Putting tasks on the calendar

- Add `#cal` to a dated task, optionally with a time: `⏰ 14:00-15:30`.
- Or select a task and tell the command bar: `calendar friday 2pm`, `cal 9-10am`, `no calendar`.
- Route to another calendar with an alias (`#cal/study`), defined in settings as `study = Coursework`.

## Troubleshooting

| Message | Fix |
|---|---|
| Google didn't return a refresh token | Remove the app at [myaccount.google.com/permissions](https://myaccount.google.com/permissions), then Connect again. |
| Access blocked / invalid_client | The id or secret was pasted wrongly, or the client type wasn't *Desktop app*. |
| Sign-in stops working after about a week | The app is still in *Testing*. Publish it (step 6) and reconnect. |
| Nothing happens after approving | Keep Obsidian open: it listens on a local address for Google's reply, for up to 3 minutes. |
