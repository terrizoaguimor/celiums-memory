declare global {
	namespace App {
		interface Locals {
			user?: {
				userId: string;
				username: string;
				apiKey: string;
			};
		}
	}
}

export {};
