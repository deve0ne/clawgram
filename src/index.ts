import { createChannelPlugin } from './channel';
import { pluginRuntimes } from './runtime-registry';
import { getTelegramUserbotCliDescriptors, registerTelegramUserbotCli } from './cli';

const plugin = {
  id: 'clawgram',
  name: 'Clawgram',
  description: "Connect your personal Telegram account to OpenClaw via MTProto. Your AI assistant responds as you.",

  register(api: any): void {
    api.registerCli(({ program, config }: { program: any; config: any }) => {
      registerTelegramUserbotCli(program, config);
    }, {
      commands: getTelegramUserbotCliDescriptors().map((entry) => entry.name),
      descriptors: getTelegramUserbotCliDescriptors()
    });

    // api.runtime carries the media-understanding pipeline; without it an
    // inbound voice note has nothing to be turned into words with.
    api.registerChannel({ plugin: createChannelPlugin(pluginRuntimes, api?.runtime) });
  }
};

export default plugin;
