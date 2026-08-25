import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clearRuntimeAuthMaterializations,
  getPreparedRuntimeAuthMaterializations,
  revokeRuntimeAuthMaterializations,
} from "../../agents/auth-profiles/runtime-materializations.js";
import { reportEmbeddedRunSuccessfulAuthBinding } from "../../agents/embedded-agent-runner/run/auth-profile-success.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadManifestMetadataSnapshot } from "../../plugins/manifest-contract-eligibility.js";
import {
  buildModelsListResult,
  createGatewayAgentModelCatalogProjector,
} from "./models-list-result.js";
import {
  listModels,
  providerCatalogEntry,
} from "./models-list-result.openai-routes.test-support.js";
import type { GatewayRequestContext } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const config = {
  agents: {
    defaults: { model: { primary: "anthropic/claude-opus-5" } },
    list: [
      {
        id: "main",
        default: true,
        models: {
          "anthropic/claude-opus-5": { agentRuntime: { id: "claude-cli" } },
        },
      },
    ],
  },
} satisfies OpenClawConfig;

async function listClaudeCliModel() {
  return await listModels({
    catalog: [],
    staticEntries: [providerCatalogEntry("anthropic", "claude-opus-5")],
    cfg: config,
    view: "configured",
  });
}

describe("models.list CLI runtime availability", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
    vi.stubEnv("CLAUDE_API_KEY", "");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not treat native Claude credential files as model availability", async () => {
    const homeDir = tempDirs.make("models-list-claude-cli-");
    const credentialDir = path.join(homeDir, ".claude");
    fs.mkdirSync(credentialDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(credentialDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "test-access",
          refreshToken: "test-refresh",
          expiresAt: Date.now() + 3_600_000,
        },
      }),
      { mode: 0o600 },
    );
    vi.stubEnv("HOME", homeDir);

    await expect(listClaudeCliModel()).resolves.toEqual({
      models: [expect.objectContaining({ id: "claude-opus-5", available: false })],
    });
  });

  it("marks a Claude CLI runtime model unavailable without ambient CLI OAuth", async () => {
    await expect(listClaudeCliModel()).resolves.toEqual({
      models: [expect.objectContaining({ id: "claude-opus-5", available: false })],
    });
  });

  it("tracks exact native runtime availability through success and revocation", async () => {
    const agentDir = tempDirs.make("models-list-native-materialization-");
    const runtimeConfig = {
      ...config,
      agents: {
        ...config.agents,
        list: [{ ...config.agents.list[0], agentDir }],
      },
    } satisfies OpenClawConfig;
    const catalogEntry = {
      id: "claude-opus-5",
      name: "Claude Opus 5",
      provider: "anthropic",
      api: "anthropic-messages" as const,
      baseUrl: "https://api.anthropic.com",
    };
    clearRuntimeAuthMaterializations(agentDir);
    setRuntimeConfigSnapshot(runtimeConfig, runtimeConfig);
    try {
      reportEmbeddedRunSuccessfulAuthBinding({
        profileStore: { version: 1, profiles: {} },
        apiKeyInfo: null,
        attempt: {} as never,
        provider: catalogEntry.provider,
        agentDir,
        modelId: catalogEntry.id,
        modelApi: catalogEntry.api,
        modelBaseUrl: catalogEntry.baseUrl,
        agentHarnessId: "claude-cli",
        pluginHarnessOwnsTransport: true,
        pluginHarnessOwnsAuthBootstrap: true,
      });
      const snapshot = { entries: [catalogEntry], routeVariants: [catalogEntry] };
      const buildCatalog = async (locked = false) => {
        const projector = createGatewayAgentModelCatalogProjector({
          cfg: runtimeConfig,
          agentId: "main",
          snapshot,
          metadataSnapshot: loadManifestMetadataSnapshot({
            config: runtimeConfig,
            env: process.env,
          }),
          preparedAuthStore: {
            version: 1,
            profiles: locked
              ? {
                  "anthropic:locked": {
                    type: "api_key",
                    provider: "anthropic",
                    key: "",
                  },
                }
              : {},
          },
          preparedRuntimeAuthMaterializations: getPreparedRuntimeAuthMaterializations(agentDir),
          ...(locked ? { lockedProfileId: "anthropic:locked" } : {}),
        });
        const context = {
          getRuntimeConfig: () => runtimeConfig,
          loadGatewayModelCatalogSnapshot: vi.fn(),
          logGateway: { debug: vi.fn() },
        } as unknown as GatewayRequestContext;
        return await buildModelsListResult({
          context,
          agentId: "main",
          params: { view: "all" },
          preloadedCatalog: {
            agentId: "main",
            config: runtimeConfig,
            snapshot,
            fullyDiscovered: true,
          },
          preloadedOnly: true,
          catalogProjector: projector,
        });
      };
      const expectAvailability = async (available: boolean, locked = false) => {
        await expect(buildCatalog(locked)).resolves.toMatchObject({
          models: [
            {
              id: catalogEntry.id,
              provider: catalogEntry.provider,
              available,
              agentRuntime: { id: "claude-cli", source: "model" },
            },
          ],
        });
      };

      await expectAvailability(true);
      await expectAvailability(false, true);
      expect(
        revokeRuntimeAuthMaterializations({
          agentDir,
          provider: catalogEntry.provider,
          runtimeOwnerId: "claude-cli",
        }),
      ).toBe(true);
      await expectAvailability(false);
    } finally {
      clearRuntimeAuthMaterializations(agentDir);
      clearRuntimeConfigSnapshot();
    }
  });
});
