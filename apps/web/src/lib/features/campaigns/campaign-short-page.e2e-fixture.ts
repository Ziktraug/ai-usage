import { mount } from 'svelte';
import '../../../index.css';
import CampaignShortPageFixture from './campaign-short-page.fixture.svelte';

const target = document.createElement('main');
target.dataset.campaignShortPageFixture = '';
document.body.replaceChildren(target);
mount(CampaignShortPageFixture, { target });
