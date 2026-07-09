import { describe, it, expect } from "vitest";
import { matchSDKs } from "../../src/engine/registry.js";
import { collectRawDependencies } from "../../src/analyzers/sdk-scanner.js";
import { fixturePath } from "../helpers/fixture-path.js";
import type { EcosystemDeps, SDKRegistryEntry } from "../../src/engine/types.js";

// Inline handcrafted registry entries only - this file deliberately does NOT
// depend on any real content file (rulepack/sdk-registry.json), per the
// brief: the matcher's contract must be verified independently of whatever
// real SDK data happens to be loaded elsewhere.

function emptyDeps(overrides: Partial<EcosystemDeps> = {}): EcosystemDeps {
  return {
    npm: [],
    pub: [],
    pods: [],
    spm: [],
    gradle: [],
    nuget: [],
    upm: [],
    ios_imports: [],
    android_imports: [],
    ...overrides,
  };
}

function makeEntry(
  id: string,
  match: SDKRegistryEntry["match"],
  extra: Partial<Omit<SDKRegistryEntry, "id" | "match">> = {}
): SDKRegistryEntry {
  return {
    id,
    name: extra.name ?? id,
    category: extra.category ?? "other",
    match,
    data_collection: extra.data_collection ?? [],
    flags: extra.flags ?? {},
  };
}

describe("matchSDKs", () => {
  it("npm: exact match only", () => {
    const deps = emptyDeps({ npm: ["react-native-purchases", "expo-camera"] });
    const registry = [makeEntry("purchases", { npm: ["react-native-purchases"] })];

    const result = matchSDKs(deps, registry);

    expect(result).toHaveLength(1);
    expect(result[0].matched_coordinates).toEqual(["npm:react-native-purchases"]);
  });

  it("npm: a pattern that is not an exact match and has no trailing '*' does not match", () => {
    const deps = emptyDeps({ npm: ["react-native-purchase"] }); // one char short
    const registry = [makeEntry("purchases", { npm: ["react-native-purchases"] })];

    expect(matchSDKs(deps, registry)).toEqual([]);
  });

  it("pub: trailing '*' is a prefix match (firebase_* matches firebase_core)", () => {
    const deps = emptyDeps({ pub: ["firebase_core", "unrelated_package"] });
    const registry = [makeEntry("firebase", { pub: ["firebase_*"] })];

    const result = matchSDKs(deps, registry);

    expect(result).toHaveLength(1);
    expect(result[0].matched_coordinates).toEqual(["pub:firebase_core"]);
  });

  it("pods: exact match is case-insensitive", () => {
    const deps = emptyDeps({ pods: ["Google-Mobile-Ads-SDK"] });
    const registry = [makeEntry("admob", { pods: ["google-mobile-ads-sdk"] })];

    const result = matchSDKs(deps, registry);

    expect(result).toHaveLength(1);
    // matched_coordinates carries the DEP string (original casing), not the pattern.
    expect(result[0].matched_coordinates).toEqual(["pods:Google-Mobile-Ads-SDK"]);
  });

  it("spm: pattern is compared lowercased against the (already-lowercased) collected slug", () => {
    const deps = emptyDeps({ spm: ["purchases-ios"] });
    const registry = [makeEntry("revenuecat", { spm: ["Purchases-iOS"] })];

    const result = matchSDKs(deps, registry);

    expect(result).toHaveLength(1);
    expect(result[0].matched_coordinates).toEqual(["spm:purchases-ios"]);
  });

  it("nuget: exact match only", () => {
    const deps = emptyDeps({ nuget: ["Plugin.InAppBilling"] });
    const registry = [makeEntry("maui-iap", { nuget: ["Plugin.InAppBilling"] })];

    expect(matchSDKs(deps, registry)).toHaveLength(1);
  });

  it("upm: exact match only", () => {
    const deps = emptyDeps({ upm: ["com.unity.ads"] });
    const registry = [makeEntry("unity-ads", { upm: ["com.unity.ads"] })];

    expect(matchSDKs(deps, registry)).toHaveLength(1);
  });

  describe("gradle bare-vs-coordinate matching", () => {
    it("a bare-artifact pattern matches a bare-artifact dep", () => {
      const deps = emptyDeps({ gradle: ["billing"] });
      const registry = [makeEntry("billing-sdk", { gradle: ["billing"] })];

      expect(matchSDKs(deps, registry)).toHaveLength(1);
    });

    it("a bare-artifact pattern matches the artifact part of a group:artifact dep", () => {
      const deps = emptyDeps({ gradle: ["com.google.android.gms:play-services-ads"] });
      const registry = [makeEntry("admob", { gradle: ["play-services-ads"] })];

      const result = matchSDKs(deps, registry);

      expect(result).toHaveLength(1);
      expect(result[0].matched_coordinates).toEqual([
        "gradle:com.google.android.gms:play-services-ads",
      ]);
    });

    it("a full 'group:artifact' pattern matches a dep of that exact full form", () => {
      const deps = emptyDeps({ gradle: ["com.google.android.gms:play-services-ads"] });
      const registry = [
        makeEntry("admob", { gradle: ["com.google.android.gms:play-services-ads"] }),
      ];

      expect(matchSDKs(deps, registry)).toHaveLength(1);
    });

    it("a full 'group:artifact' pattern does NOT match a dep with the same artifact but a different group", () => {
      const deps = emptyDeps({ gradle: ["com.other.vendor:play-services-ads"] });
      const registry = [
        makeEntry("admob", { gradle: ["com.google.android.gms:play-services-ads"] }),
      ];

      expect(matchSDKs(deps, registry)).toEqual([]);
    });
  });

  describe("ios_imports / android_imports segment-boundary prefix matching", () => {
    it("matches the import exactly", () => {
      const deps = emptyDeps({ ios_imports: ["GoogleMobileAds"] });
      const registry = [makeEntry("admob-ios", { ios_imports: ["GoogleMobileAds"] })];

      expect(matchSDKs(deps, registry)).toHaveLength(1);
    });

    it("matches a dotted child of the pattern (segment boundary via '.')", () => {
      const deps = emptyDeps({ android_imports: ["com.google.android.gms.ads.AdView"] });
      const registry = [
        makeEntry("admob-android", { android_imports: ["com.google.android.gms.ads"] }),
      ];

      const result = matchSDKs(deps, registry);

      expect(result).toHaveLength(1);
      expect(result[0].matched_coordinates).toEqual([
        "android_imports:com.google.android.gms.ads.AdView",
      ]);
    });

    it("does NOT match when there is no segment boundary (Stripe must not match StripeFake)", () => {
      const deps = emptyDeps({ ios_imports: ["StripeFake"] });
      const registry = [makeEntry("stripe", { ios_imports: ["Stripe"] })];

      expect(matchSDKs(deps, registry)).toEqual([]);
    });

    it("still matches the real SDK when both a real and a look-alike import are present", () => {
      const deps = emptyDeps({ ios_imports: ["Stripe", "StripeFake"] });
      const registry = [makeEntry("stripe", { ios_imports: ["Stripe"] })];

      const result = matchSDKs(deps, registry);

      expect(result).toHaveLength(1);
      expect(result[0].matched_coordinates).toEqual(["ios_imports:Stripe"]);
    });
  });

  it("merges coordinates matched via different ecosystem keys into a single ProfileSDK", () => {
    const deps = emptyDeps({
      npm: ["react-native-purchases"],
      pods: ["PurchasesHybridCommon"],
    });
    const registry = [
      makeEntry("revenuecat", {
        npm: ["react-native-purchases"],
        pods: ["PurchasesHybridCommon"],
      }),
    ];

    const result = matchSDKs(deps, registry);

    expect(result).toHaveLength(1);
    expect(result[0].matched_coordinates).toEqual([
      "npm:react-native-purchases",
      "pods:PurchasesHybridCommon",
    ]);
  });

  it("dedupes matched_coordinates when two patterns in the same entry match the same dep", () => {
    const deps = emptyDeps({ pub: ["firebase_core"] });
    const registry = [
      makeEntry("firebase", { pub: ["firebase_*", "firebase_core"] }),
    ];

    const result = matchSDKs(deps, registry);

    expect(result).toHaveLength(1);
    expect(result[0].matched_coordinates).toEqual(["pub:firebase_core"]);
  });

  it("produces at most one ProfileSDK per registry entry even when matched through two ecosystem keys", () => {
    const deps = emptyDeps({ npm: ["foo"], pods: ["Foo"] });
    const registry = [makeEntry("dual", { npm: ["foo"], pods: ["foo"] })];

    const result = matchSDKs(deps, registry);

    expect(result).toHaveLength(1);
  });

  it("sorts output by id", () => {
    const deps = emptyDeps({ npm: ["zeta-sdk", "alpha-sdk", "mid-sdk"] });
    const registry = [
      makeEntry("zeta", { npm: ["zeta-sdk"] }),
      makeEntry("alpha", { npm: ["alpha-sdk"] }),
      makeEntry("mid", { npm: ["mid-sdk"] }),
    ];

    const result = matchSDKs(deps, registry);

    expect(result.map((r) => r.id)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("empty deps -> []", () => {
    const registry = [
      makeEntry("firebase", { pub: ["firebase_*"] }),
      makeEntry("admob", { gradle: ["play-services-ads"] }),
    ];

    expect(matchSDKs(emptyDeps(), registry)).toEqual([]);
  });

  it("empty registry -> []", () => {
    const deps = emptyDeps({ npm: ["react-native-purchases"] });

    expect(matchSDKs(deps, [])).toEqual([]);
  });

  it("carries id/name/category/data_collection/flags through from the registry entry", () => {
    const deps = emptyDeps({ npm: ["some-sdk"] });
    const registry = [
      makeEntry(
        "some-sdk-id",
        { npm: ["some-sdk"] },
        {
          name: "Some SDK",
          category: "analytics",
          data_collection: ["usage_analytics"],
          flags: { att_required: true },
        }
      ),
    ];

    const result = matchSDKs(deps, registry);

    expect(result[0]).toEqual({
      id: "some-sdk-id",
      name: "Some SDK",
      category: "analytics",
      matched_coordinates: ["npm:some-sdk"],
      data_collection: ["usage_analytics"],
      flags: { att_required: true },
    });
  });

  describe("end-to-end with collectRawDependencies() (proves the two units compose, not just each in isolation)", () => {
    it("kotlin-app: a bare-artifact gradle pattern matches AdMob's real coordinate form", () => {
      const deps = collectRawDependencies(fixturePath("kotlin-app"), "kotlin");
      const registry = [
        makeEntry("admob", { gradle: ["play-services-ads"] }, { category: "ads" }),
        makeEntry("revenuecat", { gradle: ["com.revenuecat.purchases:purchases"] }),
      ];

      const result = matchSDKs(deps, registry);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("admob");
      expect(result[0].matched_coordinates).toEqual([
        "gradle:com.google.android.gms:play-services-ads",
      ]);
    });

    it("swift-app: an ios_imports pattern matches the raw (unfiltered) StoreKit import", () => {
      const deps = collectRawDependencies(fixturePath("swift-app"), "swift");
      const registry = [
        makeEntry("storekit", { ios_imports: ["StoreKit"] }, { category: "payment" }),
        makeEntry("not-present", { ios_imports: ["ARKit"] }),
      ];

      const result = matchSDKs(deps, registry);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("storekit");
      expect(result[0].matched_coordinates).toEqual(["ios_imports:StoreKit"]);
    });

    it("expo-app: an npm pattern matches react-native-purchases from package.json", () => {
      const deps = collectRawDependencies(fixturePath("expo-app"), "expo");
      const registry = [makeEntry("revenuecat", { npm: ["react-native-purchases"] })];

      const result = matchSDKs(deps, registry);

      expect(result).toHaveLength(1);
      expect(result[0].matched_coordinates).toEqual(["npm:react-native-purchases"]);
    });
  });
});
