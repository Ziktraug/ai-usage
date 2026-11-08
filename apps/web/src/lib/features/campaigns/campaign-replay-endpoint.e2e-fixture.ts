import { mount } from 'svelte';
import '../../../index.css';
import CampaignReplayEndpointFixture from './campaign-replay-endpoint.fixture.svelte';

const target = document.createElement('main');
document.body.replaceChildren(target);
mount(CampaignReplayEndpointFixture, { target });
