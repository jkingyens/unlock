# Unlock

Unlock is an experimental browser extension that brings the full power of the web straight to the browser. It requires an access token to an S3 bucket (or compatible API) to publish new pages and an LLM access token of your choice to generate new html pages from natural language. 

This extension is not agentic web or conversational AI in your sidebar crap. This extension is fundamentally about restoring access and agency to the web. We want more people buiding more things on the web, especially for themselves. We also want choice in every service. Openness and interoperability. 

This extension is experimental in the sense that it will solve none of your problems. However, it might drive inspiration and restore some faith that we can still evolve the web before it gets swallowed by AI agents. And depending on who you are and what you value, that might be solving a problem in your life. If you care about the open web and that sort of thing.

For the things you make (called packets) the html pages are pushed as private S3 objects. The extension takes care of presigning the URLs so they work magically in your tabs. However they are only live during packet instance lifetime. If you share a packet, external pages remain as links, but generated pages are bundled into the packet as content. The person you share with is assumed to be running the extension and will have the pages contained in the packet published to their s3 bucket, etc. The idea is everyone has their own s3 storage connected to their own browser.

This extension is in very active development. All settings and user data is stored locally inside the extension. Assume all of your data could be corrupt or break when you decide to update. This is just for messing around.

Follow along or get in touch [@jkingyens.bsky.social](https://bsky.app/profile/jkingyens.bsky.social)