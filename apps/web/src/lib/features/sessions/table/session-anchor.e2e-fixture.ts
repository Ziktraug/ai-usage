import { mount } from 'svelte';
import '../../../../index.css';
import SessionAnchorFixture from './session-anchor.fixture.svelte';

const target = document.createElement('main');
target.dataset.sessionTableBrowserFixture = 'anchor';
document.body.replaceChildren(target);
mount(SessionAnchorFixture, { target });
