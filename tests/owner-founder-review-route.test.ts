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
  FounderApplicationReviewCollectionItem,
  FounderApplicationReviewCollectionRepository,
  FounderApplicationReviewItem,
  FounderApplicationReviewListRequest,
  FounderApplicationReviewPage,
  FounderApplicationReviewRepository,
} from "../repositories/in-memory-founder-application-repository.ts";
import type { ApplicationRouteContext } from "../worker/contracts.ts";
import {
  createOwnerFounderReviewCollectionRouteHandler,
  createOwnerFounderReviewDetailRouteHandler,
  createOwnerFounderReviewRouteHandler,
} from "../worker/routes/owner-founder-review.ts";
import { createOwnerRouteHandler } from "../worker/routes/owner.ts";

const PRIVATE_EXPERTISE = "Distributed systems and product validation.";
const PRIVATE_NOTE = "Available for a confidential follow-up.";

test("owner founder review exposes equivalent collection resources", async () => {
  const item = reviewItem();
  const repository = new FakeFounderReviewRepository(item);
  const feature = createOwnerFounderReviewCollectionRouteHandler(repository);
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
  assert.equal(
    collectionDocument.links.some((link) => link.rel.includes("item")),
    false,
  );
  assert.equal(JSON.stringify(collectionDocument).includes(item.application.applicantSubject), false);
  assert.equal(JSON.stringify(collectionDocument).includes(item.application.id), false);
  const nextLink = collectionDocument.links.find(
    (link) => link.rel.includes("next"),
  );
  const ownerLink = collectionDocument.links.find(
    (link) => link.rel.includes("owner"),
  );
  assert(nextLink);
  assert(ownerLink);
  assert.equal(
    nextLink.href,
    "https://invest.example/owner/founder-applications?page_size=10&cursor=opaque-review-page%3A2",
  );
  assert.equal(ownerLink.href, "https://invest.example/owner");

  const htmlCollection = await requiredResponse(await handler(context(
    "https://invest.example/owner/founder-applications?page_size=10",
    { accept: "text/html" },
  )));
  const collectionHtml = await htmlCollection.text();
  assert.equal(htmlCollection.status, 200);
  assert.match(collectionHtml, /Founder applications/);
  assert.doesNotMatch(collectionHtml, /Review application/);
  assert.match(collectionHtml, new RegExp(item.reviewId));
  assert.match(collectionHtml, /Next page/);
  assert.match(
    collectionHtml,
    /<a href="https:\/\/invest\.example\/owner">Back to campaign workspace<\/a>/u,
  );
  assert.equal(collectionHtml.includes(item.application.applicantSubject), false);
  assert.equal(collectionHtml.includes(item.application.id), false);

  assert.equal(repository.listCalls, 2);
  assert.equal(repository.getCalls, 0);

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

test("founder review collection remains independent from detail composition", async () => {
  const item = reviewItem();
  const repository = new FakeFounderReviewRepository(item);
  const collection = createOwnerFounderReviewCollectionRouteHandler(repository);
  const detailUrl =
    `https://invest.example/owner/founder-applications/${encodeURIComponent(item.reviewId)}`;
  assert.equal(await collection(context(detailUrl)), null);

  const handler = createOwnerFounderReviewRouteHandler(repository);
  const combinedCollection = await requiredResponse(await handler(context(
    "https://invest.example/owner/founder-applications?page_size=10",
    { accept: "application/json" },
  )));
  const combinedDocument = await combinedCollection.json() as {
    links: Array<{ rel: string[]; href: string }>;
  };
  assert.equal(
    combinedDocument.links.some((link) =>
      link.rel.includes("item") &&
      link.href === detailUrl
    ),
    true,
  );
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
  assert.equal(repository.getCalls, 2);
});

test("anonymous and foreign actors receive no founder application data", async () => {
  const item = reviewItem();
  const repository = new FakeFounderReviewRepository(item);
  const handler = createOwnerFounderReviewCollectionRouteHandler(repository);
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

test("review routing bounds pagination and keeps failures canonical", async () => {
  const item = reviewItem();
  const repository = new FakeFounderReviewRepository(item);
  const handler = createOwnerFounderReviewCollectionRouteHandler(repository);

  const privateSubject = "issuer.invalid/subject:must-not-be-reflected";
  const invalidPaths = [
    "?page_size=26",
    "?page_size=01",
    "?page_size=10&page_size=11",
    "?page_size=10&cursor=",
    "?page_size=10&cursor=line%0Abreak",
    `?page_size=10&cursor=${"x".repeat(2_049)}`,
    "?cursor=opaque-without-page-size",
    `?subject=${encodeURIComponent(privateSubject)}`,
  ];
  for (const accept of ["application/json", "text/html"]) {
    for (const suffix of invalidPaths) {
      const invalid = await requiredResponse(await handler(context(
        `https://invest.example/owner/founder-applications${suffix}`,
        { accept },
      )));
      const body = await invalid.text();
      assert.equal(invalid.status, 400, `${accept} ${suffix}`);
      assert.equal(body.includes(PRIVATE_NOTE), false);
      assert.equal(body.includes(privateSubject), false);
      assert.equal(body.includes("subject="), false);
    }
  }
  assert.equal(repository.listCalls, 0);

  assert.equal(await handler(context(
    "https://invest.example/owner/founder-applications/founder-review%3Affffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    { accept: "text/html" },
  )), null);

  const ownerMethod = await requiredResponse(await handler(context(
    "https://invest.example/owner/founder-applications",
    { accept: "application/json", method: "POST" },
  )));
  assert.equal(ownerMethod.status, 405);
  const anonymousMethod = await requiredResponse(await handler(context(
    "https://invest.example/owner/founder-applications",
    { actor: null, isOwner: false, method: "POST" },
  )));
  assert.equal(anonymousMethod.status, 401);
  const foreignMethod = await requiredResponse(await handler(context(
    "https://invest.example/owner/founder-applications",
    { actor: participantActor(), isOwner: false, method: "POST" },
  )));
  assert.equal(foreignMethod.status, 404);
});

test("collection failures are finite and do not disclose adapter detail", async () => {
  const privateFailure =
    "issuer.invalid/subject:private-adapter-cause must stay hidden";
  let calls = 0;
  const repository: FounderApplicationReviewCollectionRepository = {
    async list() {
      calls += 1;
      throw new Error(privateFailure);
    },
  };
  const handler = createOwnerFounderReviewCollectionRouteHandler(repository);
  for (const accept of ["application/json", "text/html"]) {
    const response = await requiredResponse(await handler(context(
      "https://invest.example/owner/founder-applications?page_size=1",
      { accept },
    )));
    const body = await response.text();
    assert.equal(response.status, 503);
    assert.equal(body.includes(privateFailure), false);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  }
  assert.equal(calls, 2);
});

test("detail-only routing exposes no collection or unauthorized lookup", async () => {
  const item = reviewItem();
  const repository = new FakeFounderReviewRepository(item);
  const handler = createOwnerFounderReviewDetailRouteHandler(repository);

  assert.equal(await handler(context(
    "https://invest.example/owner/founder-applications",
    { accept: "application/json" },
  )), null);
  assert.equal(repository.listCalls, 0);
  assert.equal(repository.getCalls, 0);

  const detailUrl =
    `https://invest.example/owner/founder-applications/${encodeURIComponent(item.reviewId)}`;
  const detail = await requiredResponse(await handler(context(detailUrl, {
    accept: "application/json",
  })));
  assert.equal(detail.status, 200);
  assert.equal(repository.getCalls, 1);

  const queried = await requiredResponse(await handler(context(
    `${detailUrl}?private=${encodeURIComponent(PRIVATE_NOTE)}`,
    { accept: "application/json" },
  )));
  assert.equal(queried.status, 400);
  assert.equal((await queried.text()).includes(PRIVATE_NOTE), false);
  assert.equal(repository.getCalls, 1);

  for (const options of [
    { actor: null, isOwner: false },
    { actor: participantActor(), isOwner: false },
  ] as const) {
    const denied = await requiredResponse(await handler(context(detailUrl, {
      ...options,
      accept: "text/html",
    })));
    assert.equal(denied.status, options.actor === null ? 401 : 404);
    assert.equal((await denied.text()).includes(PRIVATE_NOTE), false);
  }
  assert.equal(repository.getCalls, 1);
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
    const item: FounderApplicationReviewCollectionItem = Object.freeze({
      reviewId: this.item.reviewId,
      status: this.item.application.status,
      primaryContributionAreaId:
        this.item.application.fields.primaryContributionAreaId,
      updatedAt: this.item.application.updatedAt,
      revision: this.item.application.revision,
    });
    return {
      items: [item],
      nextCursor: "opaque-review-page:2" as FounderApplicationReviewPage["nextCursor"],
    };
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
  method?: string;
}>;

function context(
  url: string,
  options: ContextOptions = {},
): ApplicationRouteContext {
  const actor = options.actor === undefined ? ownerActor() : options.actor;
  return {
    request: new Request(url, {
      method: options.method ?? "GET",
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
