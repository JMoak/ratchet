/**
 * Task 2 and 5 corpora: support routing and urgency for two imagined products.
 *
 * - Brindle Ledger (invoicing and timesheets SaaS): 8 queues, 256 tickets from 96 templates,
 *   each template used two or three times with different slot values. The task 2 gate.
 * - Fernhill Market (grocery delivery and marketplace): 7 queues, 140 tickets from 56
 *   templates, asked with a re-worded routing question and urgency rubric. The task 5 sibling
 *   that borrows a calibration profile built from Brindle's ledger.
 *
 * Every template carries the decider's route and urgency, chosen against the criteria and the
 * rubric shown to the model (DECIDER.md, "Routing and rating"). Tickets from one template are
 * correlated; the report counts templates as well as tickets.
 */
import { State } from "../../../../src/state.ts";
import { Draw, fill, type Label, label, opaqueId, usd } from "./common.ts";

export const URGENCY_LEVELS = ["low", "normal", "high", "critical"] as const;
export type Urgency = (typeof URGENCY_LEVELS)[number];

export const BRINDLE_QUEUES = [
  "billing",
  "account_access",
  "bug",
  "feature_request",
  "data_privacy",
  "integrations",
  "security",
  "sales",
] as const;
export type BrindleQueue = (typeof BRINDLE_QUEUES)[number];

export const BRINDLE_CRITERIA: Readonly<Record<BrindleQueue, string>> = {
  billing:
    "Charges, invoices, receipts, refunds of subscription fees, failed payments, changing the card on file or the billing address.",
  account_access:
    "Cannot log in, password resets, two-factor codes, single sign-on errors, locked or disabled accounts, changing the account email.",
  bug: "A feature of the product is broken, shows an error, or gives wrong results.",
  feature_request: "Asks for a capability the product does not have, or a change to how it works.",
  data_privacy:
    "Requests to export, correct or delete personal data; GDPR or CCPA questions; data processing agreements; data retention.",
  integrations:
    "Connecting or troubleshooting third-party apps and the API: Slack, QuickBooks, Xero, Zapier, webhooks, API keys, rate limits.",
  security:
    "Suspected account compromise, unrecognised logins, phishing that impersonates us, exposed credentials, vulnerability reports.",
  sales:
    "Buying, upgrading or adding seats, quotes, enterprise pricing, trials, demos, procurement paperwork.",
};

export const ROUTE_PROMPT = "Which support queue should handle this ticket?";
export const URGENCY_PROMPT =
  "How urgent is this ticket? low: a question, idea or feedback with no time pressure. normal: a request or a problem that does not stop anyone working, or has a workaround. high: blocks a person or team's work today with no workaround, or risks a missed payment or legal deadline within days. critical: an outage or data loss affecting many users, or a security breach in progress.";

/** One ticket template: the decider's route and urgency, a reason, and which label is arguable. */
export interface Template<Q extends string = string> {
  readonly id: string;
  readonly q: Q;
  readonly u: Urgency;
  /** Why the route (a phrase). */
  readonly r: string;
  readonly t: string;
  readonly ambRoute?: true;
  readonly ambUrgency?: true;
}

const T = <Q extends string>(
  id: string,
  q: Q,
  u: Urgency,
  r: string,
  t: string,
  extra: { ambRoute?: true; ambUrgency?: true } = {},
): Template<Q> => ({ id, q, u, r, t, ...extra });

export const BRINDLE_TEMPLATES: readonly Template<BrindleQueue>[] = [
  T(
    "b1",
    "billing",
    "normal",
    "duplicate charge",
    "We were charged twice for the {month} subscription: two charges of {amt} on the same day. Can you refund the duplicate?",
  ),
  T(
    "b2",
    "billing",
    "normal",
    "receipt copy",
    "Could you send me a PDF receipt for invoice {inv}? Our accountant needs it for the quarterly close, no rush.",
  ),
  T(
    "b3",
    "billing",
    "high",
    "failed payment, suspension tomorrow",
    "Our card payment failed and the banner says the workspace will be suspended tomorrow. We can't lose access during payroll week. How do we pay another way?",
  ),
  T(
    "b4",
    "billing",
    "low",
    "billing address question",
    "How do I change the billing address that prints on our invoices? We moved offices last month.",
  ),
  T(
    "b5",
    "billing",
    "low",
    "bill explanation",
    "Why did our bill go from {amt} to {amt2} this month? Just want to understand the line items.",
  ),
  T(
    "b6",
    "billing",
    "normal",
    "charged after cancelling",
    "I cancelled our plan on {date} but was still charged {amt} on the next cycle. Please refund it.",
  ),
  T(
    "b7",
    "billing",
    "high",
    "invoice correction blocking payment today",
    "Invoice {inv} shows the wrong VAT number and our finance team can't pay it until it's corrected. The payment deadline is today.",
  ),
  T(
    "b8",
    "billing",
    "low",
    "billing cycle question",
    "Is it possible to switch from monthly to annual billing at renewal? Not urgent.",
  ),
  T(
    "b9",
    "billing",
    "normal",
    "card on file (save button also misbehaves)",
    "Please update the card on file, the old one expires at the end of the month. I tried in settings but the save button just spins.",
    { ambRoute: true },
  ),
  T(
    "b10",
    "billing",
    "high",
    "bounced payment, read-only today",
    "Our account was switched to read-only because a payment of {amt} bounced. Our team of {n} can't log time today. Please help us pay right now.",
  ),
  T(
    "b11",
    "billing",
    "normal",
    "seat overbilling credit",
    "We were billed for {n} seats but only have {n2} active users. Can you credit the difference?",
  ),
  T(
    "b12",
    "billing",
    "critical",
    "company-wide suspension for non-payment",
    "All {n} of our client workspaces were suspended overnight for non-payment even though invoice {inv} was paid last week. Nobody in the company can work.",
  ),

  T(
    "a1",
    "account_access",
    "high",
    "cannot log in, reset email missing",
    "I can't log in. It says my password is wrong and the reset email never arrives. I have client invoices to send by the end of the day.",
  ),
  T(
    "a2",
    "account_access",
    "normal",
    "2FA reset",
    "I got a new phone and lost my two-factor app. How do I reset 2FA on my account? I can wait until tomorrow.",
  ),
  T(
    "a3",
    "account_access",
    "critical",
    "SSO failing for everyone",
    "Single sign-on has been failing for every user in our company since this morning with 'SAML response invalid'. {n} people can't sign in.",
  ),
  T(
    "a4",
    "account_access",
    "normal",
    "change account email",
    "Please change the email address on my account from {old} to my new work address when you get a chance.",
  ),
  T(
    "a5",
    "account_access",
    "high",
    "sole admin disabled",
    "My account says 'disabled by administrator', but I'm the only admin. I'm locked out of everything and payroll runs today.",
  ),
  T(
    "a6",
    "feature_request",
    "low",
    "longer sessions is a change to how it works",
    "Is there a way to stay signed in longer? It logs me out every day, which is a bit annoying.",
    { ambRoute: true },
  ),
  T(
    "a7",
    "account_access",
    "normal",
    "reset link expired, still logged in elsewhere",
    "The password reset link says it has expired every time I click it, even straight away. I'm still logged in on my laptop for now.",
    { ambRoute: true },
  ),
  T(
    "a8",
    "account_access",
    "high",
    "new hire cannot join today",
    "A new hire starts today and the invitation link we sent says 'invalid invitation'. She can't get into the workspace to start her onboarding.",
  ),
  T(
    "a9",
    "account_access",
    "normal",
    "2FA codes rejected, backup codes work",
    "My authenticator codes keep getting rejected. I can still log in with backup codes, but I only have {n2} left.",
  ),
  T(
    "a10",
    "account_access",
    "low",
    "how to enable 2FA",
    "How do I turn on two-factor authentication for my account?",
  ),
  T(
    "a11",
    "account_access",
    "critical",
    "nobody can log in",
    "None of our {n} staff can log in this morning: every login loops back to the sign-in page. The whole office is stuck.",
    { ambRoute: true },
  ),
  T(
    "a12",
    "account_access",
    "normal",
    "lockout after attempts, can work offline",
    "I'm locked out after too many password attempts. How long until I can try again? Not a disaster, I can work offline today.",
  ),

  T(
    "g1",
    "bug",
    "high",
    "empty CSV export before payroll",
    "The timesheet CSV export has produced an empty file since yesterday's update. Payroll is due tomorrow and we need those hours.",
  ),
  T(
    "g2",
    "bug",
    "normal",
    "tax calculation wrong, manual workaround",
    "When I add a discount line to an invoice, the total is calculated before tax instead of after. I've been fixing it by hand for now.",
  ),
  T(
    "g3",
    "bug",
    "critical",
    "editor crash for all users",
    "The invoice editor crashes to a white screen for everyone on our account, {n} users. Nobody can create or send invoices right now.",
  ),
  T(
    "g4",
    "bug",
    "low",
    "date picker preference ignored",
    "Small thing: the date picker shows Sunday as the first day of the week even though I set Monday in my preferences.",
  ),
  T(
    "g5",
    "bug",
    "normal",
    "recurring invoices a day late",
    "Recurring invoices scheduled for the 1st went out on the 2nd this month. A couple of clients asked why.",
  ),
  T(
    "g6",
    "bug",
    "high",
    "send fails with error 500",
    "Clicking 'Send' on any invoice gives 'Error 500' and nothing goes out. I have to bill {n} clients today.",
  ),
  T(
    "g7",
    "bug",
    "critical",
    "sync deleted a week of entries",
    "Last night's sync wiped every time entry from the past week for our whole team. Hundreds of hours are gone.",
  ),
  T(
    "g8",
    "bug",
    "low",
    "tooltip typo",
    "The help tooltip on the Projects page has a typo: 'recieve'.",
  ),
  T(
    "g9",
    "bug",
    "normal",
    "dashboard figure wrong",
    "The dashboard chart shows last month's revenue as zero, but the Reports page has the right figure.",
  ),
  T(
    "g10",
    "bug",
    "high",
    "cannot clock in, shift started",
    "The mobile app won't let me clock in: the button is greyed out. My shift started ten minutes ago and my hours have to be tracked.",
  ),
  T(
    "g11",
    "bug",
    "normal",
    "accent search, can scroll",
    "Search doesn't find clients whose names have accents, like 'Zoë'. I can scroll the list to find them.",
  ),
  T(
    "g12",
    "bug",
    "low",
    "dark mode readability",
    "In dark mode the invoice preview text is hard to read. Not a big deal.",
  ),

  T(
    "f1",
    "feature_request",
    "low",
    "QR codes on invoices",
    "It would be great if invoices could include a QR code for payment.",
  ),
  T(
    "f2",
    "feature_request",
    "low",
    "new portal language",
    "Any plans to support Portuguese in the client portal?",
  ),
  T(
    "f3",
    "feature_request",
    "low",
    "bulk edit rates",
    "We'd love a way to bulk-edit project rates instead of changing {n} projects one by one every January.",
  ),
  T(
    "f4",
    "feature_request",
    "low",
    "per-client due dates",
    "Suggestion: let us set a default due date of 45 days for specific clients.",
  ),
  T(
    "f5",
    "feature_request",
    "low",
    "mobile dark theme",
    "Please add a dark theme to the mobile app.",
  ),
  T(
    "f6",
    "feature_request",
    "low",
    "timesheet approvals",
    "Could you add approval workflows for timesheets? Our managers approve by email right now, which is slow.",
  ),
  T(
    "f7",
    "feature_request",
    "low",
    "summary email day",
    "Would be nice if the weekly summary email could go out on Fridays instead of Mondays.",
  ),
  T(
    "f8",
    "feature_request",
    "low",
    "multi-currency invoices",
    "We need multi-currency invoices for our EU clients starting next quarter; right now we keep a separate spreadsheet.",
  ),
  T(
    "f9",
    "feature_request",
    "low",
    "collapsible sidebar",
    "Can you make the sidebar collapsible? It takes up a lot of room on small laptop screens.",
  ),
  T(
    "f10",
    "feature_request",
    "low",
    "hour-logging reminders",
    "Feature idea: reminders that ping people who haven't logged their hours by Friday afternoon.",
  ),
  T(
    "f11",
    "feature_request",
    "normal",
    "custom field limit reached",
    "Please raise the limit of {n} custom fields per client. We've hit it and can't add the tax field our new clients need.",
  ),
  T(
    "f12",
    "feature_request",
    "high",
    "e-invoicing needed to bill next week",
    "Our biggest client requires Peppol e-invoices from next week, and without that format we can't bill them at all. Is this on your roadmap?",
  ),

  T(
    "p1",
    "data_privacy",
    "normal",
    "GDPR access request",
    "Under GDPR I'd like a copy of all the personal data you hold about me.",
  ),
  T(
    "p2",
    "data_privacy",
    "normal",
    "account and data deletion",
    "Please delete my account and all the data associated with it. I no longer use the service.",
  ),
  T(
    "p3",
    "data_privacy",
    "low",
    "server location and DPA",
    "Where are your servers located, and do you have a data processing agreement we can sign?",
  ),
  T(
    "p4",
    "data_privacy",
    "high",
    "erasure with legal deadline Friday",
    "A former employee has asked us to erase their personal data, and the legal deadline is this Friday. How do we remove their time entries and profile?",
  ),
  T(
    "p5",
    "data_privacy",
    "low",
    "retention after closing",
    "How long do you keep invoices after an account is closed?",
  ),
  T(
    "p6",
    "data_privacy",
    "normal",
    "sub-processor list",
    "Our privacy officer needs your list of sub-processors for our annual review this month.",
  ),
  T(
    "p7",
    "data_privacy",
    "normal",
    "correct client personal data",
    "One of our clients wants their contact details corrected on all past invoices we've sent through your system.",
  ),
  T(
    "p8",
    "data_privacy",
    "low",
    "data sharing question",
    "Do you sell or share usage data with advertisers?",
  ),
  T(
    "p9",
    "data_privacy",
    "high",
    "CCPA deadline tomorrow",
    "We received a CCPA request from a customer and the response deadline is tomorrow. We need an export of all their records.",
  ),
  T(
    "p10",
    "data_privacy",
    "low",
    "AI training question",
    "Can you confirm whether our data is used to train any AI models?",
  ),
  T(
    "p11",
    "data_privacy",
    "normal",
    "analytics opt-out request",
    "I'd like to opt out of product analytics tracking for my user account.",
  ),
  T(
    "p12",
    "data_privacy",
    "low",
    "retention policy page",
    "Is there a page that describes your retention policy for deleted projects?",
  ),

  T(
    "i1",
    "integrations",
    "normal",
    "notifications stopped",
    "The {int} integration stopped posting invoice notifications to our channel last week.",
  ),
  T(
    "i2",
    "integrations",
    "high",
    "sync token expired before close today",
    "Our {int} sync fails with 'token expired', and invoices aren't reaching our accounting system before month-end close today.",
  ),
  T(
    "i3",
    "integrations",
    "low",
    "API filter question",
    "Does your API support filtering time entries by tag?",
  ),
  T(
    "i4",
    "integrations",
    "normal",
    "webhook retries",
    "Webhook deliveries to our endpoint keep getting retried even though we return 200 OK.",
  ),
  T(
    "i5",
    "integrations",
    "high",
    "rate limited, billing run blocked",
    "We're getting HTTP 429 rate-limit errors from your API on every call, and tonight's billing run can't start.",
  ),
  T(
    "i6",
    "integrations",
    "low",
    "connector scope question",
    "Is there a {int} connector for timesheets, or only for invoices?",
  ),
  T(
    "i7",
    "integrations",
    "low",
    "API key rotation question",
    "How do I rotate an API key without breaking our existing scripts?",
  ),
  T(
    "i8",
    "integrations",
    "critical",
    "API down, customer portal down",
    "Your API has returned 503 for every request for the past hour. Our customer portal depends on it and is down for all of our users.",
    { ambRoute: true },
  ),
  T(
    "i9",
    "integrations",
    "normal",
    "duplicate clients on sync",
    "{int} creates a duplicate client every time it syncs. I've been merging them by hand.",
  ),
  T(
    "i10",
    "integrations",
    "low",
    "API docs location",
    "Where can I find the API docs for creating recurring invoices?",
  ),
  T(
    "i11",
    "integrations",
    "normal",
    "Zapier double trigger",
    "Our Zapier trigger fires twice for every new invoice, so our CRM gets two copies.",
  ),
  T(
    "i12",
    "integrations",
    "high",
    "export mapping wrong, audit tomorrow",
    "After your update the {int} export mapping changed, and every invoice since Monday is wrong in our accountant's ledger. Our audit is tomorrow.",
  ),

  T(
    "s1",
    "security",
    "critical",
    "active takeover, bank details changed",
    "I just got login alerts from three countries in the last hour and someone changed our payout bank details. Please lock our account now.",
  ),
  T(
    "s2",
    "security",
    "high",
    "API key exposed publicly",
    "I accidentally pushed our API key to a public GitHub repository an hour ago. What should I do?",
  ),
  T(
    "s3",
    "security",
    "normal",
    "phishing report",
    "We received an email that looks like it's from you asking us to 'verify billing' on a strange domain. Is this phishing?",
    { ambUrgency: true },
  ),
  T(
    "s4",
    "security",
    "critical",
    "intruder sending fake invoices now",
    "Someone is logged into my account and is sending fake invoices with their own bank details to {n} of my clients. It's happening right now.",
  ),
  T(
    "s5",
    "security",
    "normal",
    "minor vulnerability report",
    "I'm a security researcher and found a minor information disclosure on your status page. Where should I report it?",
    { ambUrgency: true },
  ),
  T(
    "s6",
    "security",
    "high",
    "unrecognised session persists",
    "There's a session in my active devices that I don't recognise, from a city I've never been to. I changed my password but the session is still listed.",
  ),
  T(
    "s7",
    "security",
    "low",
    "allow-listing question after odd login",
    "Does your platform support IP allow-listing? Our security team flagged an odd login attempt last week.",
    { ambRoute: true },
  ),
  T(
    "s8",
    "security",
    "critical",
    "admin email hijacked, bank account swapped",
    "Our admin's email address was changed without our knowledge and we've lost access. Invoices are going out with a different bank account.",
  ),
  T(
    "s9",
    "security",
    "high",
    "credentials entered on phishing page",
    "One of our employees clicked a link in a fake 'Brindle invoice' email and typed in their password. We're worried the account is compromised.",
  ),
  T(
    "s10",
    "security",
    "high",
    "payment request we never sent",
    "A client told us they got a payment request from our account that we never sent. Can you check what happened?",
  ),
  T(
    "s11",
    "security",
    "high",
    "password in a leak, force sign-out",
    "Our admin password showed up in a credential leak alert. Can you force a sign-out of all sessions?",
  ),
  T(
    "s12",
    "security",
    "low",
    "third-party breach question",
    "Were you affected by the breach at that third-party email provider in the news? Just checking.",
  ),

  T(
    "c1",
    "sales",
    "low",
    "plan price",
    "We're a team of {n}. What's the price of the Business plan billed annually?",
  ),
  T(
    "c2",
    "sales",
    "normal",
    "formal quote",
    "Could you send a formal quote for {n} seats? Our procurement team needs it to raise a purchase order.",
  ),
  T(
    "c3",
    "sales",
    "high",
    "upgrade before Thursday",
    "We want to move to Enterprise before our board meeting on Thursday. Can someone from sales call me today?",
    { ambUrgency: true },
  ),
  T("c4", "sales", "low", "non-profit discount", "Do you offer discounts for non-profits?"),
  T(
    "c5",
    "sales",
    "normal",
    "demo request",
    "We'd like a demo for our finance team sometime next week.",
  ),
  T("c6", "sales", "low", "trial question", "Is there a free trial of the Enterprise features?"),
  T(
    "c7",
    "sales",
    "normal",
    "SOC 2 report for contract",
    "Our security team needs your SOC 2 report before we can sign the contract.",
    { ambRoute: true },
  ),
  T("c8", "sales", "low", "how to add seats", "How do I add {n2} more seats to our current plan?"),
  T(
    "c9",
    "sales",
    "high",
    "renewal order form due Friday",
    "Our contract renewal is due Friday and we need the updated order form signed by then, or legal won't approve it.",
  ),
  T(
    "c10",
    "sales",
    "low",
    "plan comparison",
    "What's the difference between the Team and Business plans?",
  ),
  T(
    "c11",
    "sales",
    "normal",
    "vendor comparison pricing",
    "We're comparing vendors and need pricing for {n} users with SSO by the end of the month.",
  ),
  T("c12", "sales", "low", "reseller pricing", "Do you have reseller or partner pricing?"),
];

export const FERNHILL_QUEUES = [
  "delivery",
  "returns",
  "payments",
  "login",
  "product_info",
  "seller_support",
  "fraud",
] as const;
export type FernhillQueue = (typeof FERNHILL_QUEUES)[number];

export const FERNHILL_CRITERIA: Readonly<Record<FernhillQueue, string>> = {
  delivery:
    "Where an order is, late or missing deliveries, delivery slots, wrong address, items damaged in transit.",
  returns:
    "Returning items, refunds for returned, spoiled or unwanted items, substitutions the customer did not want.",
  payments:
    "Card declined, double charges, promo codes not applied, gift card balances, payment methods.",
  login:
    "Cannot sign in, password resets, verification codes, locked accounts, changing the account email or phone.",
  product_info:
    "Questions about a product: ingredients, allergens, sizes, availability, shelf life, recalls.",
  seller_support:
    "Sellers on the marketplace: listings, payouts to sellers, seller fees, shop suspensions, inventory sync.",
  fraud:
    "Unauthorised orders or charges, account takeover, scam messages impersonating Fernhill, stolen gift cards.",
};

export const SIBLING_ROUTE_PROMPT = "Which team should pick up this customer or seller message?";
export const SIBLING_URGENCY_PROMPT =
  "Rate the urgency of this message. low: a general question or request with no deadline. normal: a problem that needs fixing but does not stop the customer or seller today. high: stops a customer or seller from completing something today, or puts money or health at risk within a day or two. critical: many customers or sellers affected at once, an account takeover or fraud in progress, or a food-safety danger.";

export const FERNHILL_TEMPLATES: readonly Template<FernhillQueue>[] = [
  T(
    "d1",
    "delivery",
    "high",
    "order stuck, window closing",
    "My grocery order for the {slot} slot today still says 'preparing' and the delivery window closes in an hour. I need this for dinner tonight.",
  ),
  T(
    "d2",
    "delivery",
    "normal",
    "left at wrong building",
    "The driver left my order at the wrong building. A neighbour brought it over, but the frozen items had thawed.",
  ),
  T(
    "d3",
    "delivery",
    "low",
    "change regular slot",
    "Can I change my regular delivery slot from Tuesday mornings to Thursday evenings?",
  ),
  T(
    "d4",
    "delivery",
    "normal",
    "damaged in transit",
    "Order {ord} arrived with the eggs smashed. Everything else was fine.",
  ),
  T(
    "d5",
    "delivery",
    "critical",
    "all deliveries in an area cancelled",
    "Your app shows every delivery in the {area} area as cancelled this evening. Our community group of {n} households has no groceries coming.",
  ),
  T(
    "d6",
    "delivery",
    "low",
    "Sunday delivery times",
    "What time do you usually deliver on Sundays?",
  ),
  T(
    "d7",
    "delivery",
    "normal",
    "repeatedly late",
    "My order {ord} was delivered two hours late, the second time this week.",
  ),
  T(
    "d8",
    "delivery",
    "high",
    "medical cooler packs missing",
    "I'm housebound and my order with the cooler packs for my insulin hasn't come. It was due at noon and it's now 4pm.",
  ),

  T(
    "r1",
    "returns",
    "normal",
    "unwanted substitution refund",
    "You substituted oat milk for the whole milk I ordered. I didn't want that. Can I get a refund for it?",
  ),
  T(
    "r2",
    "returns",
    "low",
    "return policy question",
    "What's your return policy for unopened dry goods?",
  ),
  T(
    "r3",
    "returns",
    "normal",
    "marketplace return",
    "I'd like to return the blender I bought from a marketplace seller; it's the wrong model.",
  ),
  T(
    "r4",
    "returns",
    "normal",
    "spoiled produce refund",
    "Please refund the {amt} for the strawberries in order {ord}; they were mouldy when I opened the box this morning.",
  ),
  T(
    "r5",
    "returns",
    "low",
    "return shipping question",
    "If I return something to a marketplace seller, who pays for the return shipping?",
  ),
  T(
    "r6",
    "returns",
    "high",
    "refund overdue, rent due",
    "I sent a coffee machine back three weeks ago and still haven't got the {amt} refund. My rent is due on Friday.",
  ),
  T(
    "r7",
    "returns",
    "normal",
    "refused substitutions",
    "Two items in my order were substitutions even though I'd marked 'no substitutes'. I want them refunded.",
  ),
  T("r8", "returns", "low", "gift return question", "Can I return a gift without the receipt?"),

  T(
    "y1",
    "payments",
    "high",
    "card declined, slot expiring",
    "My card keeps getting declined at checkout even though it works everywhere else, and my delivery slot expires in 30 minutes.",
  ),
  T(
    "y2",
    "payments",
    "normal",
    "double charge",
    "I was charged twice for order {ord}, {amt} each time.",
  ),
  T("y3", "payments", "low", "payment method question", "Do you accept PayPal?"),
  T(
    "y4",
    "payments",
    "normal",
    "promo code not applied",
    "The promo code WELCOME10 didn't apply at checkout even though it's my first order.",
  ),
  T(
    "y5",
    "payments",
    "low",
    "gift card balance",
    "How do I check the balance on my Fernhill gift card?",
  ),
  T(
    "y6",
    "payments",
    "normal",
    "receipt and bank disagree",
    "The total on my receipt is {amt}, but my bank shows {amt2}.",
  ),
  T(
    "y7",
    "payments",
    "critical",
    "checkout down for everyone",
    "Checkout fails with 'payment service unavailable' for everyone. Our neighbourhood chat says nobody can pay tonight.",
  ),
  T(
    "y8",
    "payments",
    "low",
    "remove old card",
    "Please remove my old card from my account; I've added a new one.",
  ),

  T(
    "l1",
    "login",
    "high",
    "no SMS code, order deadline",
    "I can't sign in because the verification code never arrives by text, and I need to place an order before 6pm.",
  ),
  T(
    "l2",
    "login",
    "normal",
    "app login fails, website works",
    "I changed phones and now the app won't accept my password. I can still order on the website.",
  ),
  T(
    "l3",
    "login",
    "low",
    "change phone number question",
    "How do I change the phone number on my account?",
  ),
  T(
    "l4",
    "login",
    "normal",
    "locked after attempts",
    "My account is locked after too many attempts. When can I try again?",
  ),
  T(
    "l5",
    "login",
    "critical",
    "nobody can sign in",
    "The app has logged everyone out and nobody in our house or our neighbours' can sign back in tonight.",
  ),
  T(
    "l6",
    "login",
    "low",
    "change account email",
    "Please change the email on my account to my new address.",
  ),
  T(
    "l7",
    "login",
    "high",
    "reset link expired, delivery to reschedule today",
    "The password reset link says it has expired every time, and I'm locked out with a delivery to reschedule today.",
  ),
  T(
    "l8",
    "login",
    "low",
    "sign in with Google question",
    "Is there a way to sign in with Google instead of a password?",
  ),

  T(
    "q1",
    "product_info",
    "normal",
    "allergen question",
    "Does your own-brand granola contain tree nuts? My son is allergic.",
    { ambUrgency: true },
  ),
  T(
    "q2",
    "product_info",
    "low",
    "size availability",
    "Is the {product} available in a larger size?",
  ),
  T(
    "q3",
    "product_info",
    "low",
    "shelf life question",
    "What's the shelf life of your frozen dumplings once thawed?",
  ),
  T(
    "q4",
    "product_info",
    "critical",
    "recalled chicken already eaten",
    "The chicken I bought yesterday is on a recall list I saw on the news. My family already ate some. What should we do?",
  ),
  T("q5", "product_info", "low", "restock question", "When will the oat milk be back in stock?"),
  T(
    "q6",
    "product_info",
    "low",
    "organic question",
    "Are your bananas organic? The listing doesn't say.",
  ),
  T(
    "q7",
    "product_info",
    "high",
    "gluten label contradicts ingredients",
    "The label on the {product} says gluten-free, but the ingredients list wheat flour. Which is right? I'm coeliac.",
    { ambUrgency: true },
  ),
  T("q8", "product_info", "low", "halal question", "Do you sell halal meat?"),

  T(
    "e1",
    "seller_support",
    "high",
    "seller payout missing, supplier due",
    "I'm a seller and my payout of {amt} hasn't arrived. I need it to pay my supplier tomorrow.",
  ),
  T(
    "e2",
    "seller_support",
    "normal",
    "inventory sync wrong",
    "My listings show the wrong stock count after the inventory sync.",
  ),
  T(
    "e3",
    "seller_support",
    "low",
    "seller fee question",
    "What are the seller fees for the home goods category?",
  ),
  T(
    "e4",
    "seller_support",
    "normal",
    "misattributed review",
    "A customer left a review on my shop that belongs to a different seller. How do I get it moved?",
  ),
  T(
    "e5",
    "seller_support",
    "critical",
    "seller portal down for all sellers",
    "The seller portal has been down for all sellers since this morning. None of us can update orders.",
  ),
  T(
    "e6",
    "seller_support",
    "low",
    "add seller user",
    "How do I add a second user to my seller account?",
  ),
  T(
    "e7",
    "seller_support",
    "normal",
    "listing fee charged twice",
    "I was charged a {amt} listing fee twice this month on my seller account.",
    { ambRoute: true },
  ),
  T(
    "e8",
    "seller_support",
    "high",
    "shop suspended, orders to ship today",
    "My shop was suspended for 'policy violation' and I have {n} orders to ship today.",
  ),

  T(
    "x1",
    "fraud",
    "critical",
    "unauthorised orders now",
    "Someone placed three orders on my account tonight to an address I don't know, and my saved card was charged.",
  ),
  T(
    "x2",
    "fraud",
    "normal",
    "scam voucher text",
    "I got a text saying I won a Fernhill voucher and need to enter my card details at a link. Is it real?",
    { ambUrgency: true },
  ),
  T(
    "x3",
    "fraud",
    "critical",
    "account takeover",
    "My account email was changed and I didn't do it. I can't get back in.",
  ),
  T(
    "x4",
    "fraud",
    "high",
    "gift card drained",
    "The gift card I bought last week shows a zero balance and I never used it. Someone else must have spent it.",
  ),
  T(
    "x5",
    "fraud",
    "normal",
    "unrecognised charge",
    "There's a charge from Fernhill on my statement for {amt} that I don't recognise.",
  ),
  T(
    "x6",
    "fraud",
    "low",
    "how to spot fake emails",
    "How can I tell if an email claiming to be from Fernhill is genuine?",
  ),
  T(
    "x7",
    "fraud",
    "critical",
    "seller impersonated to customers now",
    "I'm a seller and someone is messaging my customers right now pretending to be me and asking them to pay outside the platform.",
  ),
  T(
    "x8",
    "fraud",
    "high",
    "password entered on fake text link",
    "I clicked a link in a fake Fernhill delivery text and entered my password before I realised.",
  ),
];

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

const MONTHS = ["July", "August", "September", "October"];
const INTEGRATIONS = ["Slack", "QuickBooks", "Xero", "HubSpot", "Zapier"];
const NAMES = ["Priya", "Marco", "Dana", "Tomás", "Aiko", "Leah", "Sam", "Noor"];
const COMPANIES = [
  "Halyard Design",
  "Oakline Builders",
  "Corvid Labs",
  "Pinecrest Dental",
  "Lumen Films",
];
const SLOTS = ["5-6pm", "6-7pm", "7-8pm", "8-9am"];
const AREAS = ["Riverside", "Northgate", "Elm Park", "Harbourside"];
const PRODUCTS = ["own-brand pasta", "sourdough loaf", "oat crackers", "veggie burgers"];

export function slotsFor(d: Draw): Record<string, string> {
  const amt = d.money(19, 480);
  return {
    n: String(d.int(6, 60)),
    n2: String(d.int(2, 5)),
    amt: usd(amt),
    amt2: usd(Math.round(amt * d.pick([1.4, 1.8, 2.2]) * 100) / 100),
    inv: `INV-${d.int(1000, 9999)}`,
    month: d.pick(MONTHS),
    date: `2026-${String(d.int(8, 10)).padStart(2, "0")}-${String(d.int(1, 28)).padStart(2, "0")}`,
    int: d.pick(INTEGRATIONS),
    old: `${d.pick(NAMES).toLowerCase()}@${d.pick(["gmail.com", "outlook.com", "proton.me"])}`,
    name: d.pick(NAMES),
    co: d.pick(COMPANIES),
    slot: d.pick(SLOTS),
    ord: `FM-${d.int(100000, 999999)}`,
    area: d.pick(AREAS),
    product: d.pick(PRODUCTS),
  };
}

const OPENERS = ["", "Hi,", "Hello,", "Hi team,", "Hey there,", "Good morning,"];
const CLOSERS = ["", "Thanks!", "Thanks, {name}", "Regards, {name}", "{name}, {co}", "Cheers"];

export interface TicketItem<Q extends string = string> {
  readonly id: string;
  readonly template: string;
  readonly product: "brindle" | "fernhill";
  readonly body: string;
  readonly state: string;
  readonly route: Label & { readonly truth: Q };
  readonly urgency: Label & { readonly truth: Urgency };
}

export const CHANNELS = ["email", "web form", "in-app chat"];
export const PLANS = ["Team", "Business", "Enterprise"];
const ACCOUNTS = ["customer", "customer", "marketplace seller"];

/** The state a help desk would build: its own fields trusted, the customer's message not. */
export function ticketState(
  product: "brindle" | "fernhill",
  id: string,
  channel: string,
  account: string,
  body: string,
): string {
  const title =
    product === "brindle" ? "Brindle Ledger support inbox" : "Fernhill Market help desk";
  return State.create(title)
    .field("ticket", id)
    .field("channel", channel)
    .field(product === "brindle" ? "customer plan" : "account type", account)
    .untrusted("message", body)
    .build().text;
}

function renderTickets<Q extends string>(
  product: "brindle" | "fernhill",
  templates: readonly Template<Q>[],
  queues: readonly Q[],
  perQueue: number,
  seed: number,
): TicketItem<Q>[] {
  const d = new Draw(seed);
  const out: TicketItem<Q>[] = [];
  const ids = new Set<string>();
  for (const q of queues) {
    // A queue's own templates; a template whose route is arguable may sit under another queue's
    // letter (a6 is filed as feature_request), so templates are grouped by their label.
    const mine = d.shuffle(templates.filter((t) => t.q === q));
    for (let i = 0; i < perQueue; i++) {
      const t = mine[i % mine.length] as Template<Q>;
      const slots = slotsFor(d);
      const opener = d.pick(OPENERS);
      const closer = fill(d.pick(CLOSERS), slots);
      const body = [opener, fill(t.t, slots), closer].filter((s) => s !== "").join(" ");
      let id = opaqueId(d, product === "brindle" ? "T" : "F");
      while (ids.has(id)) id = opaqueId(d, product === "brindle" ? "T" : "F");
      ids.add(id);
      out.push({
        id,
        template: t.id,
        product,
        body,
        state: ticketState(
          product,
          id,
          d.pick(CHANNELS),
          d.pick(product === "brindle" ? PLANS : ACCOUNTS),
          body,
        ),
        route: { ...label(t.q, `${t.q}: ${t.r}`, t.ambRoute === true), truth: t.q },
        urgency: { ...label(t.u, `${t.u}: ${t.r}`, t.ambUrgency === true), truth: t.u },
      });
    }
  }
  return d.shuffle(out);
}

/** 8 queues x 32 tickets: 256 Brindle tickets (task 2). */
export const buildRouting = (seed = 47): TicketItem<BrindleQueue>[] =>
  renderTickets("brindle", BRINDLE_TEMPLATES, BRINDLE_QUEUES, 32, seed);

/** 7 queues x 20 tickets: 140 Fernhill tickets (task 5 sibling). */
export const buildSibling = (seed = 53): TicketItem<FernhillQueue>[] =>
  renderTickets("fernhill", FERNHILL_TEMPLATES, FERNHILL_QUEUES, 20, seed);
