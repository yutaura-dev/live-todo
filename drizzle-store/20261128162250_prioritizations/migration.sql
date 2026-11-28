CREATE TABLE `prioritizations` (
	`task_id` text PRIMARY KEY,
	`status` text NOT NULL,
	`priority` text,
	`basis_fingerprint` text NOT NULL,
	`driven_by_item_id` text,
	CONSTRAINT `fk_prioritizations_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`)
);
