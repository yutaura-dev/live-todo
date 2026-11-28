import { Layer } from "effect";
import { StoreDatabase } from "../../store/database.js";
import { PrioritizationStore } from "../../store/prioritization-store.js";
import { TaskStore } from "../../store/task-store.js";
import { AiSettingsStore } from "../../store/ai-settings-store.js";
import { AiServices } from "./ai/ai-services.js";
import { AiSettingsService } from "./ai/ai-settings-service.js";
import type { AiConnector } from "./ai/connector.js";
import { Prioritizer, type Calendar } from "./prioritizer.js";
import { TaskService, type TaskIds } from "./task-service.js";

/** main プロセスの層の組み立て（起動とテストで同じ形にする）。AI につなぐ口（connector）は、起動とテストで差し替える */
export const desktopLayer = (options: {
  database: Layer.Layer<StoreDatabase>;
  calendar: Layer.Layer<Calendar>;
  ids: Layer.Layer<TaskIds>;
  connector: Layer.Layer<AiConnector>;
}) => {
  const stores = Layer.mergeAll(TaskStore.layer, PrioritizationStore.layer, AiSettingsStore.layer).pipe(Layer.provide(options.database));
  const ai = AiServices.live;
  const settings = AiSettingsService.layer.pipe(Layer.provide(Layer.mergeAll(stores, ai, options.connector)));
  const prioritizer = Prioritizer.layer.pipe(Layer.provide(Layer.mergeAll(stores, options.calendar, ai)));
  return Layer.mergeAll(TaskService.layer.pipe(Layer.provide(Layer.mergeAll(stores, prioritizer, options.ids))), settings);
};
