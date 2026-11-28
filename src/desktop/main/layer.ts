import { Layer } from "effect";
import { StoreDatabase } from "../../store/database.js";
import { PrioritizationStore } from "../../store/prioritization-store.js";
import { TaskStore } from "../../store/task-store.js";
import { Prioritizer, type Calendar } from "./prioritizer.js";
import { TaskService, type TaskIds } from "./task-service.js";

/** main プロセスの層の組み立て（起動とテストで同じ形にする）。Decisions は AI 設定ができたら、呼ぶ側で足す */
export const desktopLayer = (options: { database: Layer.Layer<StoreDatabase>; calendar: Layer.Layer<Calendar>; ids: Layer.Layer<TaskIds> }) => {
  const stores = Layer.mergeAll(TaskStore.layer, PrioritizationStore.layer).pipe(Layer.provide(options.database));
  const prioritizer = Prioritizer.layer.pipe(Layer.provide(Layer.merge(stores, options.calendar)));
  return TaskService.layer.pipe(Layer.provide(Layer.mergeAll(stores, prioritizer, options.ids)));
};
