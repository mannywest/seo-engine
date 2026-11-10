# Service catalogue (working name: Lodestar)

Everything the service could include, grouped so features can be sold alone or in bundles later.

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
| Weekly posts | Updates and offers drafted from the website and past articles | Approve | To build |
| Photos | Reminders and uploads on a schedule | Guided | To build |
| Review monitoring | Alert on every new review | Auto | To build |
| Review replies | Drafted in the owner's tone. Never posted without approval by default | Approve | To build |
| Ask-for-a-review link and QR code | Printable card and text message template | Auto | To build |
| Performance numbers | Views, calls, directions, website clicks, by month | Auto | To build |
| Suggested-edit watch | Alerts when Google or the public changes the listing, with accept or reject | Approve | To build |
| Questions and answers | No API is listed in Google's current docs. Guided checklist only | Guided | To build |
| Duplicate listing check | Finds duplicates and explains how to resolve them | Guided | To build |

**Honest limits.** Google's Business Profile APIs are not public. Each project must apply for access, and Google says approval can take up to 14 days. Google recommends agencies register as an organisation and be added as a manager, never an owner. New listings cannot be seen publicly until verified. Google also says edits are generally accepted but not guaranteed. Sources: [Google FAQ](https://developers.google.com/my-business/content/faq), [Google locations setup guide](https://developers.google.com/my-business/content/locations-setup).

## 2. Local presence beyond Google

| Feature | What the owner gets | Mode | Status |
|---|---|---|---|
| Name, address, phone consistency check | Finds mismatches across the web | Auto | To build |
| Directory and citation list | A ranked list of directories to join, with ready-to-paste details | Guided | To build |
| Bing Places and Apple Business Connect | Same profile details, step by step | Guided | To build |
| Local landing pages | A page per town or service, written from the client's real facts | Approve | To build |

## 3. Website content

| Feature | What the owner gets | Mode | Status |
|---|---|---|---|
| Topic planning | Topics from the owner's services and real searches | Auto | Built |
| Articles | Researched, checked, written in the owner's tone | Approve | Built |
| Fact and claim checks | Figures must trace to a source, banned phrases blocked | Auto | Built |
| Service and FAQ pages | Draft pages for services not yet explained | Approve | To build |
| Refresh old content | Finds stale pages and drafts updates | Approve | Built (detection) |
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

## 5. Search performance

| Feature | What the owner gets | Mode | Status |
|---|---|---|---|
| Search Console connection | Real search numbers, by connecting once | Guided | Built |
| Opportunities | Pages near page one, titles with low clicks, missing topics | Auto | Built |
| Rank movement | From Search Console only. Not a live rank tracker | Auto | Built |
| Competitor tracking | Needs paid data. Not part of the free build | Not possible free | Not built |
| Keyword research | Limited without paid data. Uses Search Console and the business's own services | Auto | Partly built |

## 6. AI search (ChatGPT, Gemini, Google AI answers)

| Feature | What the owner gets | Mode | Status |
|---|---|---|---|
| AI-readiness checks | Crawler access, answer-first writing, FAQs, freshness | Auto | Built |
| Live AI-citation checks | Does an assistant mention the business when asked? | Auto | To build |

## 7. Authority and reputation

| Feature | What the owner gets | Mode | Status |
|---|---|---|---|
| Link ideas | Local partners, suppliers, associations, press angles | Guided | To build |
| Buying or swapping links | Breaks Google's rules and risks penalties | Not possible | n/a |
| Review growth | Review requests and reply drafts (see section 1) | Approve | To build |

## 8. Tracking and reporting

| Feature | What the owner gets | Mode | Status |
|---|---|---|---|
| Analytics setup | Step-by-step GA4 setup and call/form tracking | Guided | To build |
| Monthly report | Plain English: what we did, what changed, what is next | Auto | To build |
| Results dashboard | Calls, directions, clicks, searches, articles live | Auto | To build |
| Email and phone alerts | Things that need the owner | Auto | To build |

## 9. The platform (self service)

| Feature | What the owner gets | Mode | Status |
|---|---|---|---|
| Setup wizard from a website address | Reads the site and fills in the business details | Auto | Built (command line) |
| Connections | Git (pull request), WordPress, webhook for others | Guided | Built |
| Approval inbox | One place to approve articles, posts, replies | Approve | To build |
| Accounts, team roles, billing | Sign-up, invite a colleague, plans | n/a | To build |
| Per-feature switches | Needed to sell features or bundles | n/a | To build |

## Draft bundles (to refine later)

- **Found locally**: section 1, section 2, monthly report.
- **Grow**: Found locally plus section 3 and section 5.
- **Everything**: all of the above plus section 4, section 6 and section 7.

Prices are not set here.
