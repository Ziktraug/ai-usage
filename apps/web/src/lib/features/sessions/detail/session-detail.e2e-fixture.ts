import { mount } from 'svelte';
import '../../../../index.css';
import SessionDetailFixture from './session-detail.fixture.svelte';

const target = document.createElement('main');
document.body.replaceChildren(target);
mount(SessionDetailFixture, { target });
