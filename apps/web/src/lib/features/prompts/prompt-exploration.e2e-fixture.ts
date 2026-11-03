import { mount } from 'svelte';
import '../../../index.css';
import PromptExplorationFixture from './prompt-exploration.fixture.svelte';

const target = document.createElement('div');
document.body.replaceChildren(target);
mount(PromptExplorationFixture, { target });
