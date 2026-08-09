import assert from "node:assert/strict";
import test from "node:test";

import {
  createFounderApplication,
  parseContributionAreaChoices,
  type FounderApplication,
} from "../domain/founder-application.ts";
import { parseActorSubject } from "../domain/foundation.ts";
import { INVESTOR_APP_MEDIA_TYPE } from "../domain/public-campaign-resource.ts";
import type {
  FounderApplicationReviewItem,
  FounderApplicationReviewListRequest,
  FounderApplicationReviewPage,
  FounderApplicationReviewRepository,
} from "../repositories/in-memory-founder-application-repository.ts";
import type { ApplicationRouteContext } from "../worker/contracts.ts";
import { createOwnerFounderReviewRouteHandler } from "../worker/routes/owner-founder-review.ts";
import { createOwnerRouteHandler } from "../worker/routes/owner.ts";

const PRIVATE_EXPERTISE = "Distributed systems and product validation.";
const PRIVATE_NOTE = "Available for a confidential follow-up.";

test("owner founder review exposes equivalent collection and detail resources", async () => {
  const item = reviewItem();
  const repository = new FakeFounderReviewRepository(item);
  const feature = createOwnerFounderReviewRouteHandler(repository);
  const handler = createOwnerRouteHandler([feature], {
    founderApplicationReview: true,
  });

  const jsonCollection = await requiredResponse(await handler(context(
    "https://invest.example/owner/founder-applications?page_size=10",
    { accept: `${INVESTOR_APP_MEDIA_TYPE}; version=0.1` },
  )));
  assert.equal(jsonCollection.status, 200);
  const collectionDocument = await jsonCollection.json() as {
    type: string;
    data: { items: Array<{ review_id: string; status: string }> };
    links: Array<{ rel: string[]; href: string }>;
  };
  assert.equal(collectionDocument.type, "owner-founder-application-collection");
  assert.equal(collectionDocument.data.items[0].review_id, item.reviewId);
  assert.equal(collectionDocument.data.items[0].status, "received");
  const itemLink = collectionDocument.links.find(
    (link) => link.rel.includes("item"),
  );
  assert(itemLink);
  assert.equal(
    itemLink.href,
    `https://invest.example/owner/founder-applications/${encodeURIComponent(item.reviewId)}`,
  );
  assert.equal(JSON.stringify(collectionDocument).includes(item.application.applicantSubject), false);

  const htmlCollection = await requiredResponse(await handler(context(
    "https://invest.example/owner/founder-applications?page_size=10",
    { accept: "text/html" },
  )));
  const collectionHtml = await htmlCollection.text();
  assert.equal(htmlCollection.status, 200);
  assert.match(collectionHtml, /Founder applications/);
  assert.match(collectionHtml, /Review application/);
  assert.match(collectionHtml, new RegExp(encodeURIComponent(item.reviewId)));
  assert.equal(collectionHtml.includes(item.application.applicantSubject), false);

  const detailUrl =
    `https://invest.example/owner/founder-applications/${encodeURIComponent(item.reviewId)}`;
  const jsonDetail = await requiredResponse(await handler(context(detailUrl, {
    accept: "application/json",
  })));
  const detailDocument = await jsonDetail.json() as {
    type: string;
    id: string;
    data: {
      expertise_summary: string;
      note: string;
      history: Array<{ transition: string }>;
    };
  };
  assert.equal(detailDocument.type, "owner-founder-application");
  assert.equal(detailDocument.id, item.reviewId);
  assert.equal(detailDocument.data.expertise_summary, PRIVATE_EXPERTISE);
  assert.equal(detailDocument.data.note, PRIVATE_NOTE);
  assert.deepEqual(
    detailDocument.data.history.map((entry) => entry.transition),
    ["created"],
  );
  assert.equal(JSON.stringify(detailDocument).includes(item.application.applicantSubject), false);

  const htmlDetail = await requiredResponse(await handler(context(detailUrl, {
    accept: "text/html",
  })));
  const detailHtml = await htmlDetail.text();
  assert.equal(htmlDetail.status, 200);
  assert.match(detailHtml, new RegExp(PRIVATE_EXPERTISE));
  assert.match(detailHtml, new RegExp(PRIVATE_NOTE));
  assert.match(detailHtml, /Application history/);
  assert.equal(detailHtml.includes(item.application.applicantSubject), false);
  assert.equal(repository.listCalls, 2);
  assert.equal(repository.getCalls, 2);

  const ownerHome = await requiredResponse(await handler(context(
    "https://invest.example/owner",
    { accept: "application/json" },
  )));
  const ownerHomeDocument = await ownerHome.json() as {
    type: string;
    links: Array<{ rel: string[]; href: string }>;
  };
  assert.equal(ownerHomeDocument.type, "owner-home");
  assert.equal(
    ownerHomeDocument.links.some((link) =>
      link.rel.includes("founder-applications") &&
      link.href === "https://invest.example/owner/founder-applications"
    ),
    true,
  );
});

test("anonymous and foreign actors receive no founder application data", async () => {
  const item = reviewItem();
  const repository = new FakeFounderReviewRepository(item);
  const handler = createOwnerFounderReviewRouteHandler(repository);
  const url = "https://invest.example/owner/founder-applications";

  for (const accept of ["application/json", "text/html"]) {
    const anonymous = await requiredResponse(await handler(context(url, {
      accept,
      actor: null,
      isOwner: false,
    })));
    const anonymousBody = await anonymous.text();
    assert.equal(anonymous.status, 401);
    assert.equal(anonymousBody.includes(PRIVATE_EXPERTISE), false);
    assert.equal(anonymousBody.includes(PRIVATE_NOTE), false);

    const foreign = await requiredResponse(await handler(context(url, {
      accept,
      actor: participantActor(),
      isOwner: false,
    })));
    const foreignBody = await foreign.text();
    assert.equal(foreign.status, 404);
    assert.equal(foreignBody.includes(PRIVATE_EXPERTISE), false);
    assert.equal(foreignBody.includes(PRIVATE_NOTE), false);
  }
  assert.equal(repository.listCalls, 0);
  assert.equal(repository.getCalls, 0);
});

test("review routing bounds pagination and preserves non-disclosing misses", async () => {
  const item = reviewItem();
  const repository = new FakeFounderReviewRepository(item);
  const handler = createOwnerFounderReviewRouteHandler(repository);

  const invalid = await requiredResponse(await handler(context(
    "https://invest.example/owner/founder-applications?page_size=101",
    { accept: "application/json" },
  )));
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.text()).includes(PRIVATE_NOTE), false);

  const missing = await requiredResponse(await handler(context(
    "https://invest.example/owner/founder-applications/founder-review%3Affffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    { accept: "text/html" },
  )));
  assert.equal(missing.status, 404);
  assert.equal((await missing.text()).includes(PRIVATE_EXPERTISE), false);
});

class FakeFounderReviewRepository
implements FounderApplicationReviewRepository {
  listCalls = 0;
  getCalls = 0;
  private readonly item: FounderApplicationReviewItem;

  constructor(item: FounderApplicationReviewItem) {
    this.item = item;
  }

  async list(
    request: FounderApplicationReviewListRequest,
  ): Promise<FounderApplicationReviewPage> {
    this.listCalls += 1;
    assert.equal(request.limit, 10);
    return { items: [this.item], nextCursor: null };
  }

  async get(reviewId: unknown): Promise<FounderApplicationReviewItem | null> {
    this.getCalls += 1;
    return reviewId === this.item.reviewId ? this.item : null;
  }
}

type ContextOptions = Readonly<{
  accept?: string;
  actor?: ApplicationRouteContext["actor"];
  isOwner?: boolean;
}>;

function context(
  url: string,
  options: ContextOptions = {},
): ApplicationRouteContext {
  const actor = options.actor === undefined ? ownerActor() : options.actor;
  return {
    request: new Request(url, {
      headers: { Accept: options.accept ?? "text/html" },
    }),
    url: new URL(url),
    resourceUrl: url,
    actor,
    isOwner: options.isOwner ?? actor?.email === "owner@example.invalid",
    participantAccess: null,
    campaign: null,
    renderApplication: async () => new Response("application fallback"),
  };
}

function ownerActor() {
  return {
    userId: "site-user:owner",
    email: "owner@example.invalid",
    displayName: "Configured Owner",
  };
}

function participantActor() {
  return {
    userId: "site-user:participant",
    email: "participant@example.invalid",
    displayName: "Participant",
  };
}

function reviewItem(): FounderApplicationReviewItem {
  const choices = parseContributionAreaChoices([
    { id: "area:engineering", label: "Engineering" },
    { id: "area:product", label: "Product" },
  ]);
  const subject = parseActorSubject("issuer.invalid/subject:applicant");
  assert.equal(choices.ok, true);
  assert.equal(subject.ok, true);
  if (!choices.ok || !subject.ok) throw new Error("Invalid test fixture.");
  const created = createFounderApplication({
    id: "founder-application:review",
    applicantSubject: subject.value,
    occurredAt: "2026-08-09T10:00:00.000Z",
    historyEntryId: "founder-history:review-create",
    fields: {
      expertiseSummary: PRIVATE_EXPERTISE,
      intendedContribution: "Lead a focused implementation track.",
      primaryContributionAreaId: "area:engineering",
      secondaryContributionAreaIds: ["area:product"],
      approximateAvailability: "Two days each week.",
      possibleStartTiming: "After mutual confirmation.",
      compensationExpectation: "Open to discussion.",
      professionalProfileLinks: ["https://profiles.example.invalid/applicant"],
      note: PRIVATE_NOTE,
    },
  }, choices.value);
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("Invalid founder application fixture.");
  return Object.freeze({
    reviewId:
      "founder-review:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    application: created.value as FounderApplication,
  });
}

async function requiredResponse(
  response: Response | null,
): Promise<Response> {
  assert.notEqual(response, null);
  return response as Response;
}
