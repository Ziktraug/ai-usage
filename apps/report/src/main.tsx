import { render } from 'solid-js/web';
import { AppRouter } from './router';
import './index.css';

const root = document.getElementById('root');

if (!root) throw new Error('Missing #root');

render(() => <AppRouter />, root);
