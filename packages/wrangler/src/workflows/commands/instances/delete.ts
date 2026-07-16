import { createCommand } from "../../../core/create-command";
import { logger } from "../../../logger";
import { requireAuth } from "../../../user";
import {
	deleteLocalInstance,
	getLocalInstanceIdFromArgs,
	localWorkflowArgs,
} from "../../local";
import { deleteInstance, getInstanceIdFromArgs } from "../../utils";

export const workflowsInstancesDeleteCommand = createCommand({
	metadata: {
		description: "Delete a workflow instance and its stored state",
		owner: "Product: Workflows",
		status: "stable",
	},
	positionalArgs: ["name", "id"],
	args: {
		...localWorkflowArgs,
		name: {
			describe: "Name of the workflow",
			type: "string",
			demandOption: true,
		},
		id: {
			describe:
				"ID of the instance - you can type 'latest' to get the latest instance and delete it",
			type: "string",
			demandOption: true,
		},
	},

	async handler(args, { config }) {
		let id: string;

		if (args.local) {
			id = await getLocalInstanceIdFromArgs(args.port, args);
			await deleteLocalInstance(args.port, args.name, id);
		} else {
			const accountId = await requireAuth(config);
			id = await getInstanceIdFromArgs(accountId, args, config);
			await deleteInstance(config, accountId, args.name, id);
		}

		logger.info(
			`🗑️  The instance "${id}" from ${args.name} was deleted successfully`
		);
	},
});
