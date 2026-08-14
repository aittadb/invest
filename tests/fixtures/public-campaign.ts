import type { PublicCampaignConfiguration } from "../../domain/public-campaign-configuration.ts";

export const syntheticPublicCampaign = {
  id: "northstar-robotics",
  published: true,
  status: "open",
  name: "Northstar Robotics",
  pageTitle: "Northstar Robotics pre-registration",
  pageDescription:
    "Learn about Northstar Robotics and share non-binding investor or founder interest.",
  phaseLabel: "Investment pre-registration",
  statusLabel: "Pre-registration open",
  brandMarkUrl: null,
  heroImageUrl: null,
  socialImageUrl: null,
  navigation: [
    { label: "Opportunity", href: "#opportunity" },
    { label: "Product", href: "#product" },
    { label: "Process", href: "#process" },
    { label: "Risks", href: "#risks" },
    { label: "Questions", href: "#faq" },
  ],
  hero: {
    summary: "Reliable inspection robots for hard-to-reach industrial sites.",
    invitation:
      "Review the opportunity and share non-binding interest as an investor or potential founder.",
    primaryActionLabel: "Register your interest",
    secondaryAction: { label: "Explore the product", href: "#product" },
    note: "Pre-registration is non-binding and does not reserve shares or create an investment commitment.",
  },
  facts: [
    { label: "Current phase", value: "Pre-registration" },
    { label: "Ways to participate", value: "Investor or founder" },
    { label: "Expression of interest", value: "Non-binding" },
  ],
  participation: {
    eyebrow: "Take part",
    title: "Choose the path that fits you",
    paths: [
      {
        kind: "investor",
        title: "Investor interest",
        description:
          "Request access to the information package and share an amount you may consider investing.",
        actionLabel: "Continue as an investor",
      },
      {
        kind: "founder",
        title: "Founder interest",
        description:
          "Tell us about your expertise, possible contribution, and availability.",
        actionLabel: "Continue as a potential founder",
      },
    ],
  },
  product: {
    eyebrow: "The product",
    title: "Inspection where people should not have to go",
    description:
      "Northstar Robotics develops compact inspection systems for industrial environments where access is costly or hazardous.",
    links: [
      {
        label: "Visit Northstar Robotics",
        href: "https://northstar.example/",
        rel: ["about", "product"],
      },
      {
        label: "View public materials",
        href: "https://northstar.example/materials",
        rel: ["alternate"],
      },
    ],
    capabilities: [
      {
        label: "Inspect",
        description: "Capture repeatable visual and sensor observations remotely.",
      },
      {
        label: "Report",
        description: "Organize findings into reviewable inspection records.",
      },
    ],
  },
  process: {
    eyebrow: "Pre-registration process",
    title: "Learn first. Decide at your own pace.",
    steps: [
      {
        title: "Sign in",
        description: "Create your access profile and choose how you may participate.",
      },
      {
        title: "Review",
        description: "Read the current information package and its notices.",
      },
      {
        title: "Share interest",
        description: "Submit, edit, or withdraw a non-binding indication.",
      },
    ],
  },
  risks: {
    eyebrow: "Before you continue",
    title: "Interest now. Decisions later.",
    items: [
      "This invitation records interest and is not a securities offer.",
      "No payment, allocation, reservation, or binding commitment happens here.",
      "Any later arrangement requires separate review and formal documentation.",
    ],
  },
  faq: {
    eyebrow: "Common questions",
    title: "A clear first conversation",
    items: [
      {
        question: "Does pre-registering create a commitment?",
        answer: "No. It records non-binding interest that can be changed or withdrawn.",
      },
      {
        question: "Can I express both investor and founder interest?",
        answer: "Yes. The two paths are recorded and reviewed separately.",
      },
    ],
  },
  closing: {
    eyebrow: "Investment pre-registration",
    title: "Interested in helping Northstar Robotics move forward?",
    actionLabel: "Register your interest",
  },
  footer: {
    tagline: "Non-binding investment and founder pre-registration.",
    links: [
      {
        label: "Northstar Robotics",
        href: "https://northstar.example/",
        rel: ["about", "product"],
      },
    ],
  },
} as const satisfies PublicCampaignConfiguration;
