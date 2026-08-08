import 'fake-indexeddb/auto';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, it } from 'vitest';
import { useConversationsStore } from '../src/stores/conversations';

describe('dbg', () => {
  beforeEach(() => setActivePinia(createPinia()));
  it('inspect $state keys', () => {
    const store = useConversationsStore();
    console.log('STATE_KEYS=' + JSON.stringify(Object.keys(store.$state)));
    console.log('HAS scopedOwnerId ref?', 'scopedOwnerId' in store);
    store.scopedOwnerId = 'x';
    console.log('after set proxy=', store.scopedOwnerId, 'state=', store.$state.scopedOwnerId);
  });
});
