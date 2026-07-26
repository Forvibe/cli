// Adversarial coverage for the two signals added in the full-corpus rework.
//
// These regexes now run over EVERY file in a project rather than a curated
// 35-file slice, so precision is the whole game. A loose UGC pattern puts a
// high-severity 1.2 finding on an innocent app; a loose moderation pattern
// makes a genuinely unmoderated UGC app PASS. The negative cases below are
// therefore as load-bearing as the positive ones.

import { describe, it, expect } from "vitest";
import { scanSourceSignals } from "../../src/engine/profile-builder.js";

const ugc = (content: string) =>
  scanSourceSignals({ files: [{ path: "a.dart", content }] }).ugc_surface_found;

/** Moderation only counts alongside UGC in the same file, so pair them. */
const moderation = (content: string) =>
  scanSourceSignals({
    files: [{ path: "a.dart", content: `addComment();\n${content}` }],
  }).moderation_controls_found;

describe("UGC surface detection", () => {
  it("matches content verbs bound to social nouns", () => {
    expect(ugc("Future<void> addComment(String text) async {}")).toBe(true);
    expect(ugc("await api.addSharedFlashCardComment(id, text);")).toBe(true);
    expect(ugc("function createPost(body) {}")).toBe(true);
    expect(ugc("await deleteSharedFlashCardComment(commentId);")).toBe(true);
    expect(ugc("const n = post.commentCount;")).toBe(true);
    expect(ugc("widget.likeCount")).toBe(true);
    expect(ugc("void upvotePost() {}")).toBe(true);
    expect(ugc("class FeedViewModel extends ChangeNotifier {}")).toBe(true);
    expect(ugc("final author = set.sharedBy;")).toBe(true);
  });

  it("does not fire on ordinary app code that merely contains the words", () => {
    // A naive comment|report|block|share|feed|post OR matched 32% of files on a
    // real app. Everything below is why that design is unusable.
    expect(ugc("Crashlytics.reportError(e);")).toBe(false);
    expect(ugc("final crashReport = buildReport();")).toBe(false);
    expect(ugc("const blockSize = 4096;")).toBe(false);
    expect(ugc("import 'package:share_plus/share_plus.dart';")).toBe(false);
    expect(ugc("RatingBar(initialRating: 3);")).toBe(false);
    expect(ugc("showFeedbackForm();")).toBe(false);
    expect(ugc("await http.postRequest(url);")).toBe(false);
    expect(ugc("final code = user.getPostalCode();")).toBe(false);
    expect(ugc("await prefs.setString('k', v); // sharedPreferences")).toBe(false);
    expect(ugc("// this is a comment about comments")).toBe(false);
  });

  it("does not treat an AI chat cache as user-generated content", () => {
    // addMessage/sendMessage is how every chatbot writes its own conversation
    // history. Flagging those would put a 1.2 finding on every AI app.
    expect(ugc("void addMessage(ChatMessage m) => _messages.add(m);")).toBe(false);
    expect(ugc("await sendMessage(prompt);")).toBe(false);
    expect(ugc("_conversation.addMessage(reply);")).toBe(false);
  });
});

describe("moderation control detection", () => {
  it("matches report/block affordances on user content", () => {
    expect(moderation("Future<void> reportComment(int id) async {}")).toBe(true);
    expect(moderation("await api.reportSharedFlashCardSet(setId, reason);")).toBe(true);
    expect(moderation("void blockUser(String id) {}")).toBe(true);
    expect(moderation("final list = await getBlockedUsers();")).toBe(true);
    expect(moderation("void blockCommentAuthor() {}")).toBe(true);
    expect(moderation("enum ContentReportReason { spam, abuse }")).toBe(true);
  });

  it("does not accept bare words or unrelated identifiers as moderation", () => {
    // A false positive here is the worst outcome the engine can produce: a
    // real 1.2 violation would silently pass.
    expect(moderation("final report = generateReport();")).toBe(false);
    expect(moderation("const block = blocks[i];")).toBe(false);
    expect(moderation("await Sentry.captureBugReport(e);")).toBe(false);
    expect(moderation("class ReportBuilder {}")).toBe(false);
    expect(moderation("Crashlytics.reportErrorToUser(e);")).toBe(false);
    expect(moderation("import 'package:blockchain/blockchain.dart';")).toBe(false);
    expect(moderation("// we should add moderation someday")).toBe(false);
  });

  it("requires moderation to co-occur with UGC in the same file", () => {
    // A support-ticket "report this AI reply" dialog is not 1.2 moderation.
    // Seen for real: chat/widgets/report_dialog.dart in a Flutter app.
    const s = scanSourceSignals({
      files: [
        { path: "lib/features/shared/comments.dart", content: "void addComment() {}" },
        { path: "lib/features/chat/report_dialog.dart", content: "void reportMessage() {}" },
      ],
    });
    expect(s.ugc_surface_found).toBe(true);
    expect(s.moderation_controls_found).toBe(false);
  });

  it("accepts moderation when it sits with the content it moderates", () => {
    const s = scanSourceSignals({
      files: [
        {
          path: "lib/core/services/api_service.dart",
          content: "Future addComment() async {}\nFuture reportComment() async {}",
        },
      ],
    });
    expect(s.ugc_surface_found).toBe(true);
    expect(s.moderation_controls_found).toBe(true);
  });
});
