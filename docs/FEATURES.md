# Service catalogue (working name: Lodestar)

Everything the service could include, grouped so features can be sold alone or in plans. Prices in section 13 are proposals and are not final.

**Mode** says who does the work:
- **Auto**: the engine does it with no one involved.
- **Approve**: the engine prepares it, the owner taps approve.
- **Guided**: the owner must do a step (for example type a PIN); the app walks them through it.
- **Not possible**: cannot be done honestly or safely.

**Status** says what exists today: **Built** (code exists, tested offline only), **To build**, **Not possible**.

## 1. Google Business Profile (local search, maps)

| Feature | What the owner gets | Mode | Status |
|---|---|---|---|
| Find or create the profile | We check if the business is already on Google. If not, we create it | Guided | To build |
| Verification | Google sends a PIN (email, text, phone call or postcard). Owner enters it in the app. Postcards take days | Guided | To build |
| Complete the profile | Right categories, services, hours, description, attributes, opening dates, holiday hours | Approve | To build |
| Holiday and special hours | Before each bank holiday the assistant asks the owner if they are open, then updates Google | Approve | To build |
| Weekly posts | Updates and offers drafted from the website and past articles | Approve | To build |
| Photos | Reminders and uploads on a schedule | Guided | To build |
| Review monitoring | Alert on every new review | Auto | To build |
| Review replies | Drafted in the owner's tone. Never posted without approval by default. Optional automatic replies to plain 4 and 5 star reviews after an opt-in | Approve | To build |
| Ask-for-a-review link and QR code | Printable card and text message template | Auto | To build |
| Performance numbers | Views, calls, directions, website clicks, by month | Auto | To build |
| Suggested-edit watch | Alerts when Google or the public changes the listing, with accept or reject | Approve | To build |
| Questions and answers | No API is listed in Google's current docs. Guided checklist only | Guided | To build |
| Duplicate listing check | Finds duplicates and explains how to resolve them | Guided | To build |
| Suspected fake or policy-breaking review | Guidance on reporting it to Google instead of arguing in public | Guided | To build |

**Honest limits.** Google's Business Profile APIs are not public. Each project must apply for access, and Google says approval can take up to 14 days. Google recommends agencies register as an organisation and be added as a manager, never an owner. New listings cannot be seen publicly until verified. Google also says edits are generally accepted but not guaranteed. Sources: [Google FAQ](https://developers.google.com/my-business/content/faq), [Google locations setup guide](https://developers.google.com/my-business/content/locations-setup).

## 2. Local presence beyond Google

| Feature | What the owner gets | Mode | Status |
|---|---|---|---|
| Name, address, phone consistency check | Finds mismatches across the web | Auto | To build |
| Directory and citation list | A ranked list of directories to join, with ready-to-paste details | Guided | To build |
| Bing Places and Apple Business Connect | Same profile details, step by step | Guided | To build |
| Local landing pages | A page per town or service the business really serves, written from real facts and projects. Never near-identical pages for places the business does not work in | Approve | To build |

## 3. Website content

| Feature | What the owner gets | Mode | Status |
|---|---|---|---|
| Topic planning | Topics from the owner's services and real searches | Auto | Built |
| Articles | Researched, checked, written in the owner's tone | Approve | Built |
| Fact and claim checks | Figures must trace to a source, banned phrases blocked | Auto | Built |
| Service and FAQ pages | Draft pages for services not yet explained | Approve | To build |
| Price and cost pages | The assistant asks the owner for price ranges, then drafts pages that answer cost questions. Price questions often trigger AI answers, and many local businesses avoid them | Guided | To build |
| Review themes into content | A summary of what customers praise or complain about, turned into FAQs and posts | Approve | To build |
| Refresh old content | Finds pages losing clicks and drafts an update for approval | Approve | Built (detection) |
| Image alt text | Required on every article image | Auto | Built |
| Images themselves | Not generated yet | Not possible yet | To build |

## 4. Technical health

| Feature | What the owner gets | Mode | Status |
|---|---|---|---|
| Full site audit | Crawl, indexing, broken links, redirects, titles, descriptions | Auto | Built |
| Plain-English fix list | Each problem with who fixes it and how | Auto | To build |
| One-tap fixes | Titles and descriptions pushed to the site | Approve | To build |
| Speed and Core Web Vitals | Google PageSpeed results with advice | Auto | Built |
| Structured data | Article, FAQ, Organisation, LocalBusiness, Breadcrumb markup | Auto | Built |
| Sitemap, robots.txt, llms.txt, RSS | Generated and delivered | Auto | Built |
| Site health watch | Alerts if the site goes down or the certificate or domain is about to expire | Auto | To build |

## 5. Search performance

| Feature | What the owner gets | Mode | Status |
|---|---|---|---|
| Search Console connection | Real search numbers, by connecting once | Guided | Built |
| Opportunities | Pages near page one, titles with low clicks, missing topics | Auto | Built |
| Rank movement | From Search Console only. Not a live rank tracker | Auto | Built |
| Competitor tracking | Needs paid data. Not part of the free build | Not possible free | Not built |
| Map-grid rank heatmaps | Needs paid data. Not part of the free build | Not possible free | Not built |
| Keyword research | Limited without paid data. Uses Search Console and the business's own services | Auto | Partly built |

## 6. AI search (ChatGPT, Gemini, Google AI answers)

| Feature | What the owner gets | Mode | Status |
|---|---|---|---|
| AI-readiness checks | Crawler access, answer-first writing, FAQs, freshness | Auto | Built |
| Live AI-citation checks | The engine asks AI assistants the questions a local customer would ask and records whether the business is named. Shown as a trend over time, not a rank, because answers vary | Auto | To build |

## 7. Authority and reputation

| Feature | What the owner gets | Mode | Status |
|---|---|---|---|
| Link ideas | Local partners, suppliers, associations, press angles | Guided | To build |
| Outreach drafts | A personalised email for each link idea. The owner reviews and sends. No promise of replies | Approve | To build |
| Buying or swapping links | Breaks Google's rules and risks penalties | Not possible | n/a |
| Review growth | Review requests and reply drafts (see section 1) | Approve | To build |

## 8. Tracking and reporting

| Feature | What the owner gets | Mode | Status |
|---|---|---|---|
| Analytics setup | Step-by-step GA4 setup and call/form tracking | Guided | To build |
| Monthly report | Plain English: what we did, what changed, what is next | Auto | To build |
| Results dashboard | Calls, directions, clicks, searches, articles live. Shown as enquiries, not just visits | Auto | To build |
| Alerts | Things that need the owner, sent by the client assistant (section 10) | Auto | To build |
| Call tracking and AI receptionist | Needs paid phone numbers and care with name, address and phone consistency. A possible later paid add-on through a partner | Not in free build | Not built |

## 9. The platform (self service)

| Feature | What the owner gets | Mode | Status |
|---|---|---|---|
| Setup wizard from a website address | Reads the site and fills in the business details | Auto | Built (command line) |
| Connections | Git (pull request), WordPress, webhook for others | Guided | Built |
| Approval inbox | One place to approve articles, posts, replies | Approve | To build |
| Accounts, team roles, billing | Sign-up, invite a colleague, plans | n/a | To build |
| Per-feature switches | Needed to sell features or plans | n/a | To build |
| Usage and spend cap per client | Tracks AI cost for each client and stops runaway use | Auto | To build |
| Allowance meter | Shows what the plan includes each month and how much has been used | Auto | To build |

## 10. Client assistant

One assistant per client. Assistant name: to decide (placeholder). Stage 1 is scheduled and predictable (no open chat). Stage 2 adds chat once the data is trusted.

| Feature | What the owner gets | Mode | Status |
|---|---|---|---|
| Introduces itself and guides onboarding | Greets the owner as their assistant, explains each set-up step in plain English, asks for anything missing, says what happens next, and stays on hand afterwards | Auto | To build (stage 1) |
| Weekly update | A short plain-English message: what we did, what changed, what needs you | Auto | To build (stage 1) |
| Alerts | New or low reviews, fading pages, Google changes to the listing, broken connections, site down | Auto | To build (stage 1) |
| Nudges | Asks for approvals, prices, photos and holiday hours, and reminds if ignored | Guided | To build (stage 1) |
| Approve from the message | Approval links in each message that work without logging in | Approve | To build (stage 1) |
| Work log | A plain list of what the assistant actually did and when, so it is never just a label | Auto | To build (stage 1) |
| Autonomy dial and pause | Per action type, the owner chooses approve first or automatic (low-risk items only), and can pause everything with one tap | Guided | To build (stage 1) |
| Message channels | Email first. Text and WhatsApp later (paid, and WhatsApp needs approved templates). The owner chooses channels at sign-up. Service messages only, no marketing | Auto | Email to build; others later |
| Hand-off to a person | If it cannot answer or the owner is unhappy, it passes the case to the team with a summary | Auto | To build (stage 1) |
| Ask-me-anything chat | The owner asks, for example, "why did visits drop?" and gets an answer from their own data only | Auto | To build (stage 2) |

## 11. Market-parity additions

Found by reviewing competitors in November 2026. These close gaps against tools small businesses can already buy.

| Feature | What the owner gets | Mode | Status |
|---|---|---|---|
| IndexNow pings | Search engines are told about new and changed pages straight after publishing | Auto | To build |
| Internal linking | Links between the client's own pages added to each draft | Auto | To build |
| Content calendar | One view of what is planned, drafted, approved and live | Auto | To build |
| Event and weather triggers | Posts and hours updates tied to bank holidays, local events and weather for trades that depend on them. Free data sources | Approve | To build |
| Field capture | The owner sends photos and a short voice note or text after a job (email or upload link first, WhatsApp later). The assistant drafts a Google post and a project page, with job facts supplied by the owner | Approve | To build |
| Review requests by message | One neutral message to every customer on the owner's list, by email or text, with consent records. No screening by sentiment, no incentives | Approve | To build |
| Voice and tone capture | The owner supplies samples once so drafts sound like them | Guided | To build |
| Publishing for Wix, Squarespace and Shopify | Guided or one-tap publishing without a custom connector, possibly through a hosted content hub (needs study) | Guided | To build |
| Multi-location support | More than one location in one account | n/a | To build |
| Citation distribution | Submit business details to directories through a data partner | Not in free build | Not built |
| Competitor snapshot | Public facts about local competitors' profiles. No rankings. Needs a data source | Not in free build | Not built |
| Rank maps, rank tracking, backlink data | Paid data. A later add-on through a data partner | Not in free build | Not built |
| Agency white-label reports | A later channel for agencies and freelancers | n/a | Later |
| MCP and API access | Lets other tools and agents call the engine | n/a | Later |

Deliberately out of scope for now: Google Ads management, social media posting, email marketing and CRM.

## 12. Differentiators

Features that no competitor reviewed offers in this form, or offers only to large enterprises. Confidence is moderate: absence in search results is not proof of absence in the market.

| Feature | What the owner gets | Mode | Status |
|---|---|---|---|
| Proof pack | Every draft shows each claim, its source, what was checked, and why the page exists, before approval. Optional public "how this page was made" note | Approve | Built (proof file per article; public note not built) |
| Business facts vault | The owner confirms hours, prices, services, areas and policies once. The engine uses them for the site markup, the Google profile, directory guidance, llms.txt and FAQ pages, and alerts when sources disagree | Guided | Built (store, drafting rules, stale-fact warning; the other uses are not built) |
| Draft claim guard | Before an article leaves the engine, anything it says about the business itself (hours, prices the business charges, phone and email, service areas, credentials, guarantees, years in business) is checked against the facts vault. Anything not confirmed is held for review. A pattern check on sentences in the business's own voice, so it can miss a claim worded some other way | Auto | Built |
| AI answer guard | Scheduled checks of what AI assistants say about the business, compared with the facts vault. It fixes the sources we control and re-tests until the answer is right. No assistant offers a correction form, so the fix is indirect and may take time. The claim-finding code is shared with the draft claim guard; the asking and re-testing is not built | Auto | To build |
| Site safety score and AI-content rescue audit | A score for thin or repetitive pages, link schemes and doorway-style pages, with what to prune. A free check for sites hurt by autopilot tools | Auto | To build |
| Capped publishing and content pruning | A monthly cap per plan, plus merge, prune and refresh recommendations | Approve | To build |
| Change ledger with safe revert | Every change is recorded with before and after numbers and a one-tap revert. Automatic revert only for technical breakage such as a page blocked from indexing | Approve | Built (article deliveries only: a ledger, and undo for folder, WordPress and GitHub; undo refuses if the page was edited since and never deletes. Not built: before and after numbers, automatic revert on breakage, the one-tap button, and changes other than article deliveries) |
| Work receipt | A monthly list of exactly what was delivered against the plan's allowance, with links to the evidence | Auto | Built |
| Agent-ready actions | Quote and booking actions that AI agents can use (WebMCP-style). A research bet: standards are early | Guided | Research |

## 13. Plans and add-ons (proposed, not final)

Prices are per month, excluding VAT, in pounds. Annual billing is proposed at ten months for twelve. Details and the allowance matrix are in the knowledge base document "Pricing and packaging proposal".

| Plan | Proposed price | For | Includes |
|---|---|---|---|
| Site check | Free | Anyone with a website | Site audit, a snapshot of what AI assistants say about the business, a site safety check, a sample draft preview |
| Local | £59 | Businesses that mainly need Maps and reviews looked after | Google profile care (completeness, holiday hours, 4 posts a month, review monitoring and reply drafts, performance numbers), directory and name-address-phone checks, site health watch, facts vault, monthly check of 10 AI questions, assistant (onboarding, weekly update, alerts, nudges, approve by link), monthly report and work receipt. 1 location, 1 site. No articles |
| Grow | £129 | Businesses that want to be found for more searches | Everything in Local, plus 4 content credits a month (an article or a page), up to 2 content refreshes, 8 posts, price and cost pages, review themes into content, field capture for up to 8 jobs, review requests by message (up to 100), AI answer guard (20 questions a month, with fixes), link ideas and outreach drafts (10 a month), Search Console and enquiry reporting, proof pack on every draft, plain-English fix list |
| Pro | £249 | Busy businesses and small multi-site owners | Everything in Grow, plus 10 content credits, 12 posts, field capture for up to 20 jobs, review requests (up to 300), weekly AI answer guard (40 questions, re-tested until fixed), assistant chat, change ledger with safe revert, up to 3 locations, a quarterly 30-minute human review, priority support |

**Add-ons (proposed).** Extra location £29. Extra pack of 4 content credits £49. Done-with-you launch (one-off) £149. Text and WhatsApp messages at cost plus a small margin, once built. Call tracking and AI receptionist, citation distribution and rank maps through partners, priced when a partner is chosen.

**Terms (proposed).** Monthly, cancel or pause any time. No setup fee. Work-delivered guarantee: if a month's listed allowance is not delivered, that month is credited. No promise of rankings, traffic or enquiries. Terms need a legal review before launch.
