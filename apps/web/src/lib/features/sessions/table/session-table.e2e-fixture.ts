import { mount } from 'svelte';
import '../../../../index.css';
import SessionTableFixture from './session-table.fixture.svelte';

const target = document.createElement('main');
target.dataset.sessionTableBrowserFixture = 'paged-campaign';
document.body.replaceChildren(target);
mount(SessionTableFixture, { props: { pagedCampaign: true }, target });
