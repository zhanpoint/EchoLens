"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type MediaAssetKind,
  type ResolvedDouyinWork,
} from "@/types/douyin";
import type { WorkMetadataPatch } from "@/lib/douyin/client-metadata";
import {
  readClientSessionCache,
  writeClientSessionCache,
} from "@/lib/transcript/client-session-cache";
import { buildWorkKey } from "@/lib/media/source";
import { readSseJsonStream } from "@/lib/http/sse";

export type ClientCacheAsset = "avatar" | MediaAssetKind;

export type CachedMediaAsset = {
  downloadName: string;
  error?: string;
  errorCode?: string;
  isLoading: boolean;
  objectKey?: string;
  url?: string;
  urlExpiresAt?: number;
  verified?: boolean;
  workKey: string;
};

type AssetPayload = {
  contentType: string;
  objectKey?: string;
  sizeBytes: number;
  url: string;
  urlExpiresAt?: number;
  verified?: boolean;
};

type RefreshedUpstreamAssets = Partial<Record<Exclude<ClientCacheAsset, "originalAudio">, AssetPayload>>;

type AssetResponse =
  | { asset: AssetPayload; refreshedAssets?: RefreshedUpstreamAssets }
  | { code?: string; error: string };

export type PreparationEvent =
  | { metadata: WorkMetadataPatch; type: "metadata" }
  | { asset: AssetPayload & { asset: ClientCacheAsset }; type: "asset" }
  | { asset: ClientCacheAsset; error: string; code?: string; type: "asset-error" }
  | { type: "done" }
  | { error: string; code?: string; type: "error" };

export type MediaPreparationApi = {
  codedError: (message: string, code?: string) => Error;
  createAuthRequiredError: () => Error;
  getApiError: (payload: unknown) => { code?: string; error: string } | undefined;
  isAuthRequiredError: (error: unknown) => boolean;
  isUnauthenticatedApiResponse: (response: Response, payload: unknown) => boolean;
  readApiPayload: (response: Response, fallback: string) => Promise<unknown>;
  readUserFacingError: (error: unknown, fallback: string) => string;
  readUserFacingErrorCode: (error: unknown) => string | undefined;
  throwApiError: (payload: { code?: string; error: string } | undefined, fallback: string) => never;
};

export function useWorkPreparation(
  input: {
    activeHistoryRecordId: string;
    activeWorkKey: string;
    api: MediaPreparationApi;
    onAuthRequired: () => void;
    onMetadata: (workKey: string, metadata: WorkMetadataPatch) => void;
    userId: string;
    works: ResolvedDouyinWork[];
  },
): {
  avatar?: CachedMediaAsset;
  avatarUrl?: string;
  cachedAssets: Partial<Record<MediaAssetKind, CachedMediaAsset>>;
  loadingWorkKeys: ReadonlySet<string>;
  retryAsset: (workKey: string, asset: ClientCacheAsset) => void;
  retryWork: (workKey: string) => void;
} {
  const {
    activeHistoryRecordId,
    activeWorkKey,
    api,
    onAuthRequired,
    onMetadata,
    userId,
    works,
  } = input;
  const [cachedAssetsByWorkKey, setCachedAssetsByWorkKey] = useState<
    Record<string, Partial<Record<ClientCacheAsset, CachedMediaAsset>>>
  >(() => Object.fromEntries(assetCacheMemory));
  const [hydratedWorkKeys, setHydratedWorkKeys] = useState<ReadonlySet<string>>(() => new Set());
  const startedWorkKeysRef = useRef(new Set<string>());
  const controllersRef = useRef(new Map<string, AbortController>());
  const activeWork = useMemo(
    () => works.find((candidate) => buildWorkKey(candidate) === activeWorkKey),
    [activeWorkKey, works],
  );
  const preparationKey = `${activeHistoryRecordId}:${activeWorkKey}`;

  useEffect(() => {
    if (!userId || !activeWorkKey) return;
    let cancelled = false;
    void readClientSessionCache<Partial<Record<ClientCacheAsset, CachedMediaAsset>>>(
      userId,
      `media-assets:${activeWorkKey}`,
      24 * 60 * 60 * 1_000,
    ).then((cached) => {
      if (cancelled || !cached) return;
      const now = Date.now() + 5 * 60_000;
      const fresh = Object.fromEntries(Object.entries(cached).filter(([, asset]) => (
        asset?.url && (asset.urlExpiresAt === undefined || asset.urlExpiresAt > now)
      ))) as Partial<Record<ClientCacheAsset, CachedMediaAsset>>;
      if (!Object.keys(fresh).length) return;
      setCachedAssetsByWorkKey((current) => ({
        ...current,
        [activeWorkKey]: { ...fresh, ...current[activeWorkKey] },
      }));
    }).catch(() => undefined).finally(() => {
      if (!cancelled) setHydratedWorkKeys((current) => new Set(current).add(activeWorkKey));
    });
    return () => { cancelled = true; };
  }, [activeWorkKey, userId]);

  useEffect(() => {
    if (!userId || !activeWorkKey) return;
    const assets = cachedAssetsByWorkKey[activeWorkKey];
    if (!assets || !Object.values(assets).some((asset) => asset?.url)) return;
    void writeClientSessionCache(userId, `media-assets:${activeWorkKey}`, assets).catch(() => undefined);
  }, [activeWorkKey, cachedAssetsByWorkKey, userId]);

  const retryAsset = useCallback((workKey: string, assetKind: ClientCacheAsset) => {
    const existing = cachedAssetsByWorkKey[workKey]?.[assetKind];
    const work = works.find((candidate) => buildWorkKey(candidate) === workKey);
    if (!activeHistoryRecordId || !work || existing?.isLoading) return;

    setCachedAssetsByWorkKey((current) => ({
      ...current,
      [workKey]: {
        ...current[workKey],
        [assetKind]: {
          downloadName: assetKind === "avatar" ? "" : buildCachedAssetFilename(work, assetKind),
          error: existing?.error,
          errorCode: existing?.errorCode,
          isLoading: true,
          workKey,
        },
      },
    }));

    void fetch(
      `/api/transcript-history/${encodeURIComponent(activeHistoryRecordId)}/assets/${encodeURIComponent(assetKind)}?forceRefresh=1`,
      { cache: "no-store" },
    ).then(async (response) => {
      const payload = await api.readApiPayload(response, "网络连接失败，请检查网络后重试。") as AssetResponse;
      if (api.isUnauthenticatedApiResponse(response, payload)) throw api.createAuthRequiredError();
      if (!response.ok) {
        api.throwApiError(api.getApiError(payload), "网络连接失败，请检查网络后重试。");
      }
      const asset = "asset" in payload
        ? payload.asset
        : api.throwApiError(api.getApiError(payload), "网络连接失败，请检查网络后重试。");
      const refreshedAssets = Object.fromEntries(Object.entries(
        "refreshedAssets" in payload ? payload.refreshedAssets ?? {} : {},
      ).map(([kind, refreshed]) => [
        kind,
        toCachedMediaAsset(work, workKey, kind as ClientCacheAsset, refreshed),
      ]));
      setCachedAssetsByWorkKey((current) => ({
        ...current,
        [workKey]: {
          ...current[workKey],
          ...refreshedAssets,
          [assetKind]: toCachedMediaAsset(work, workKey, assetKind, asset),
        },
      }));
    }).catch((error: unknown) => {
      if (api.isAuthRequiredError(error)) {
        onAuthRequired();
        return;
      }
      setCachedAssetsByWorkKey((current) => ({
        ...current,
        [workKey]: {
          ...current[workKey],
          [assetKind]: {
            downloadName: assetKind === "avatar" ? "" : buildCachedAssetFilename(work, assetKind),
            error: api.readUserFacingError(error, "网络连接失败，请检查网络后重试。"),
            errorCode: api.readUserFacingErrorCode(error),
            isLoading: false,
            workKey,
          },
        },
      }));
    });
  }, [activeHistoryRecordId, api, cachedAssetsByWorkKey, onAuthRequired, works]);

  const retryWork = useCallback((workKey: string) => {
    for (const [assetKind, asset] of Object.entries(cachedAssetsByWorkKey[workKey] ?? {})) {
      if (asset?.error && !asset.url) retryAsset(workKey, assetKind as ClientCacheAsset);
    }
  }, [cachedAssetsByWorkKey, retryAsset]);

  useEffect(() => {
    for (const [key, assets] of Object.entries(cachedAssetsByWorkKey)) {
      assetCacheMemory.delete(key);
      assetCacheMemory.set(key, assets);
    }
    while (assetCacheMemory.size > 64) {
      const oldestKey = assetCacheMemory.keys().next().value as string | undefined;
      if (!oldestKey) break;
      assetCacheMemory.delete(oldestKey);
    }
  }, [cachedAssetsByWorkKey]);

  useEffect(() => {
    const controllers = controllersRef.current;
    const startedWorkKeys = startedWorkKeysRef.current;
    return () => {
      controllers.forEach((controller) => controller.abort());
      controllers.clear();
      startedWorkKeys.clear();
    };
  }, []);

  useEffect(() => {
    if (
      !activeWork
      || (userId && !hydratedWorkKeys.has(activeWorkKey))
      || startedWorkKeysRef.current.has(preparationKey)
    ) return;
    const assetKinds: ClientCacheAsset[] = activeWork.source === "douyin"
      ? ["avatar", "cover", "video", "originalAudio", "dubbing"]
      : ["avatar", "cover", "video", "originalAudio"];
    const freshUntil = Date.now() + 5 * 60_000;
    const existingAssets = cachedAssetsByWorkKey[activeWorkKey];
    if (assetKinds.every((asset) => {
      const cached = existingAssets?.[asset];
      return Boolean(
        cached?.url
        && (cached.urlExpiresAt === undefined || cached.urlExpiresAt > freshUntil)
      );
    })) return;

    startedWorkKeysRef.current.add(preparationKey);
    const controller = new AbortController();
    controllersRef.current.set(preparationKey, controller);

    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setCachedAssetsByWorkKey((current) => ({
        ...current,
        [activeWorkKey]: Object.fromEntries(assetKinds.map((asset) => {
          const existing = current[activeWorkKey]?.[asset];
          return [asset, existing?.url && !existing.error
            ? existing
            : {
                downloadName: asset === "avatar" ? "" : buildCachedAssetFilename(activeWork, asset),
                isLoading: true,
                workKey: activeWorkKey,
              }];
        })),
      }));
    });

    void fetch(`/api/${activeWork.source ?? "douyin"}/prepare`, {
      body: JSON.stringify({
        finalUrl: activeWork.finalUrl,
        historyRecordId: activeHistoryRecordId,
        id: activeWork.id,
        kind: activeWork.kind,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: controller.signal,
    }).then(async (response) => {
      const body = response.body;
      if (!response.ok || !body) {
        const payload = await api.readApiPayload(response, "作品资源准备失败。");
        if (api.isUnauthenticatedApiResponse(response, payload)) throw api.createAuthRequiredError();
        api.throwApiError(api.getApiError(payload), "作品资源准备失败。");
      }

      for await (const event of readSseJsonStream<PreparationEvent>(body!)) {
        if (event.type === "metadata") {
          onMetadata(activeWorkKey, event.metadata);
          continue;
        }
        if (event.type === "asset") {
          const asset = event.asset;
          setCachedAssetsByWorkKey((current) => {
            return {
              ...current,
              [activeWorkKey]: {
                ...current[activeWorkKey],
                [asset.asset]: {
                  downloadName: asset.asset === "avatar"
                    ? ""
                    : buildCachedAssetFilename(activeWork, asset.asset, asset.contentType),
                  isLoading: false,
                  objectKey: asset.objectKey,
                  url: asset.url,
                  urlExpiresAt: asset.urlExpiresAt,
                  verified: asset.asset === "originalAudio" ? asset.verified === true : undefined,
                  workKey: activeWorkKey,
                },
              },
            };
          });
          continue;
        }
        if (event.type === "asset-error") {
          setCachedAssetsByWorkKey((current) => ({
            ...current,
            [activeWorkKey]: {
              ...current[activeWorkKey],
              [event.asset]: {
                downloadName: event.asset === "avatar" ? "" : buildCachedAssetFilename(activeWork, event.asset),
                error: event.error,
                errorCode: event.code,
                isLoading: false,
                workKey: activeWorkKey,
              },
            },
          }));
          continue;
        }
        if (event.type === "error") throw api.codedError(event.error, event.code);
      }
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (api.isAuthRequiredError(error)) {
        onAuthRequired();
        return;
      }
      const message = api.readUserFacingError(error, "作品资源准备失败。");
      setCachedAssetsByWorkKey((current) => ({
        ...current,
        [activeWorkKey]: Object.fromEntries(assetKinds.map((asset) => {
          const existing = current[activeWorkKey]?.[asset];
          return [asset, existing?.url
            ? existing
            : {
                downloadName: asset === "avatar" ? "" : buildCachedAssetFilename(activeWork, asset),
                error: message,
                errorCode: api.readUserFacingErrorCode(error),
                isLoading: false,
                workKey: activeWorkKey,
              }];
        })),
      }));
    }).finally(() => {
      if (controllersRef.current.get(preparationKey) === controller) {
        controllersRef.current.delete(preparationKey);
      }
    });
  }, [
    activeHistoryRecordId,
    activeWork,
    activeWorkKey,
    api,
    cachedAssetsByWorkKey,
    hydratedWorkKeys,
    onAuthRequired,
    onMetadata,
    preparationKey,
    userId,
  ]);

  const loadingWorkKeys = useMemo(() => new Set(
    Object.entries(cachedAssetsByWorkKey)
      .filter(([, assets]) => Object.values(assets).some((asset) => asset?.isLoading))
      .map(([key]) => key),
  ), [cachedAssetsByWorkKey]);

  return {
    avatar: cachedAssetsByWorkKey[activeWorkKey]?.avatar,
    avatarUrl: cachedAssetsByWorkKey[activeWorkKey]?.avatar?.url,
    cachedAssets: {
      cover: cachedAssetsByWorkKey[activeWorkKey]?.cover,
      dubbing: cachedAssetsByWorkKey[activeWorkKey]?.dubbing,
      originalAudio: cachedAssetsByWorkKey[activeWorkKey]?.originalAudio,
      video: cachedAssetsByWorkKey[activeWorkKey]?.video,
    },
    loadingWorkKeys,
    retryAsset,
    retryWork,
  };
}

function toCachedMediaAsset(
  work: { id: string },
  workKey: string,
  assetKind: ClientCacheAsset,
  asset: AssetPayload,
): CachedMediaAsset {
  return {
    downloadName: assetKind === "avatar" ? "" : buildCachedAssetFilename(work, assetKind, asset.contentType),
    isLoading: false,
    objectKey: asset.objectKey,
    url: asset.url,
    urlExpiresAt: asset.urlExpiresAt,
    verified: assetKind === "originalAudio" ? asset.verified === true : undefined,
    workKey,
  };
}

const assetCacheMemory = new Map<string, Partial<Record<ClientCacheAsset, CachedMediaAsset>>>();

export function buildCachedAssetFilename(
  work: { id: string },
  asset: MediaAssetKind,
  contentType = "",
): string {
  return `echolens-${work.id}-${asset}.${readCachedAssetExtension(asset, contentType)}`;
}

function readCachedAssetExtension(asset: MediaAssetKind, contentType: string): string {
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("png")) return "png";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  if (contentType.includes("wav")) return "wav";
  if (contentType.includes("mpeg")) return "mp3";
  if (contentType.includes("mp4") && (asset === "originalAudio" || asset === "dubbing")) return "m4a";
  if (contentType.includes("mp4")) return "mp4";
  if (asset === "cover") return "jpg";
  if (asset === "originalAudio" || asset === "dubbing") return "m4a";
  return "mp4";
}