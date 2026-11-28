import { Layer } from "effect";
import { StoreDatabase } from "../../store/database.js";
import { PrioritizationStore } from "../../store/prioritization-store.js";
import { TaskStore } from "../../store/task-store.js";
import { AiSettingsStore } from "../../store/ai-settings-store.js";
import { DocumentStore } from "../../store/document-store.js";
import { SourceItemStore } from "../../store/source-item-store.js";
import { AiServices } from "./ai/ai-services.js";
import { AiSettingsService } from "./ai/ai-settings-service.js";
import type { AiConnector } from "./ai/connector.js";
import { Ingestor } from "./ingest/ingestor.js";
import { Router } from "./ingest/router.js";
import { Receiver } from "./ingest/receiver.js";
import { Prioritizer, type Calendar } from "./prioritizer.js";
import { ProposalService } from "./proposals/proposal-service.js";
import { Planner } from "./plan/planner.js";
import { AccountService } from "./sources/account-service.js";
import type { SourceGateway } from "./sources/gateway.js";
import { SyncRunner } from "./sources/sync-runner.js";
import type { WriteProvider } from "./writes/write-provider.js";
import { WriteService } from "./writes/write-service.js";
import { TaskService, type TaskIds } from "./task-service.js";

/** main プロセスの層の組み立て（起動とテストで同じ形にする）。AI につなぐ口（connector）は、起動とテストで差し替える */
export const desktopLayer = (options: {
  database: Layer.Layer<StoreDatabase>;
  calendar: Layer.Layer<Calendar>;
  ids: Layer.Layer<TaskIds>;
  connector: Layer.Layer<AiConnector>;
  gateway: Layer.Layer<SourceGateway>;
  writer: (stores: Layer.Layer<DocumentStore>) => Layer.Layer<WriteProvider>;
}) => {
  const stores = Layer.mergeAll(TaskStore.layer, PrioritizationStore.layer, AiSettingsStore.layer, SourceItemStore.layer, DocumentStore.layer).pipe(Layer.provide(options.database));
  const ai = AiServices.live;
  const settings = AiSettingsService.layer.pipe(Layer.provide(Layer.mergeAll(stores, ai, options.connector)));
  const prioritizer = Prioritizer.layer.pipe(Layer.provide(Layer.mergeAll(stores, options.calendar, ai)));
  const core = Layer.mergeAll(stores, prioritizer, ai, options.ids, options.gateway);
  const base = Layer.mergeAll(core, Planner.layer.pipe(Layer.provide(core)));
  const router = Router.layer.pipe(Layer.provide(base));
  const ingestor = Ingestor.layer.pipe(Layer.provide(base));
  const receiver = Receiver.layer.pipe(Layer.provide(base));
  const sync = SyncRunner.layer.pipe(Layer.provide(Layer.mergeAll(base, router, ingestor, receiver)));
  return Layer.mergeAll(
    TaskService.layer.pipe(Layer.provide(base)),
    settings,
    ProposalService.layer.pipe(Layer.provide(base)),
    AccountService.layer.pipe(Layer.provide(base)),
    sync,
    WriteService.layer.pipe(Layer.provide(Layer.mergeAll(base, options.writer(stores)))),
  );
};
