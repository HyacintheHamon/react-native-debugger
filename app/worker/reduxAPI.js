// Edit from https://github.com/zalmoxisus/remote-redux-devtools/blob/master/src/devTools.js

import { stringify, parse } from 'jsan';
import instrument from 'redux-devtools-instrument';
import { evalAction, getActionsArray } from 'remotedev-utils';
import { isFiltered, filterStagedActions, filterState } from 'remotedev-utils/lib/filters';

function configureStore(next, subscriber, options) {
  return instrument(subscriber, options)(next);
}

const instances = { /* id, name, store */ };

let lastAction;
let isExcess;
let listenerAdded;
let locked;
let paused;

function generateId(id) {
  return id || Math.random().toString(36).substr(2);
}

function getLiftedState(store) {
  return filterStagedActions(store.liftedStore.getState());
}

function relay(type, state, instance, action, nextActionId) {
  const { filters, stateSanitizer, actionSanitizer } = instance;

  const message = {
    type,
    id: instance.id,
    name: instance.name,
  };
  if (state) {
    message.payload = type === 'ERROR' ?
      state :
      stringify(filterState(state, type, filters, stateSanitizer, actionSanitizer, nextActionId));
  }
  if (type === 'ACTION') {
    message.action = stringify(
      !actionSanitizer ? action : actionSanitizer(action.action, nextActionId - 1)
    );
    message.isExcess = isExcess;
    message.nextActionId = nextActionId;
  } else if (action) {
    message.action = stringify(action);
  }
  postMessage({ __IS_REDUX_NATIVE_MESSAGE__: true, content: message });
}

function dispatchRemotely(action, id) {
  try {
    const { store, actionCreators } = instances[id];
    const result = evalAction(action, actionCreators);
    store.dispatch(result);
  } catch (e) {
    relay('ERROR', e.message, instances[id]);
  }
}

function handleMessages(message) {
  const { id, instanceId, type, action, state, toAll } = message;
  if (toAll) {
    Object.keys(instances).forEach(key => {
      handleMessages({ ...message, id: key, toAll: false });
    });
    return;
  }

  const { store } = instances[id || instanceId];
  if (!store) return;

  if (type === 'IMPORT') {
    store.liftedStore.dispatch({
      type: 'IMPORT_STATE',
      nextLiftedState: parse(state),
    });
  }
  if (type === 'UPDATE' || type === 'IMPORT') {
    relay('STATE', getLiftedState(store), instances[id]);
  }
  if (type === 'ACTION') {
    dispatchRemotely(action, id);
  } else if (type === 'DISPATCH') {
    store.liftedStore.dispatch(action);
  }
}

function start(instance) {
  if (!listenerAdded) {
    self.addEventListener('message', message => {
      const { method, content } = message.data;
      if (method === 'emitReduxMessage') {
        handleMessages(content);
      }
    });
    listenerAdded = true;
  }
  const { store, actionCreators } = instance;
  if (typeof actionCreators === 'function') {
    instance.actionCreators = actionCreators();
  }
  relay('STATE', getLiftedState(store), instance, instance.actionCreators);
}

function checkForReducerErrors(liftedState, instance) {
  if (liftedState.computedStates[liftedState.currentStateIndex].error) {
    relay('STATE', filterStagedActions(liftedState, instance.filters), instance);
    return true;
  }
  return false;
}

function monitorReducer(state = {}, action) {
  lastAction = action.type;
  return state;
}

function handleChange(state, liftedState, maxAge, instance) {
  if (checkForReducerErrors(liftedState, instance)) return;

  const { filters } = instance;
  if (lastAction === 'PERFORM_ACTION') {
    const nextActionId = liftedState.nextActionId;
    const liftedAction = liftedState.actionsById[nextActionId - 1];
    if (isFiltered(liftedAction.action, filters)) return;
    relay('ACTION', state, instance, liftedAction, nextActionId);
    if (!isExcess && maxAge) isExcess = liftedState.stagedActionIds.length >= maxAge;
  } else {
    if (lastAction === 'JUMP_TO_STATE') return;
    if (lastAction === 'PAUSE_RECORDING') {
      paused = liftedState.isPaused;
    } else if (lastAction === 'LOCK_CHANGES') {
      locked = liftedState.isLocked;
    }
    if (paused || locked) {
      if (lastAction) lastAction = undefined;
      else return;
    }
    relay('STATE', filterStagedActions(liftedState, filters), instance);
  }
}

export default function devToolsEnhancer(options = {}) {
  const {
    name,
    maxAge = 30,
    shouldCatchErrors = !!global.shouldCatchErrors,
    shouldHotReload,
    shouldRecordChanges,
    shouldStartLocked,
    pauseActionType = '@@PAUSED',
    actionCreators,
    filters,
    actionsBlacklist,
    actionsWhitelist,
    actionSanitizer,
    stateSanitizer,
  } = options;
  const id = generateId(options.instanceId);

  return next => (reducer, initialState) => {
    const store = configureStore(
      next, monitorReducer, {
        maxAge,
        shouldCatchErrors,
        shouldHotReload,
        shouldRecordChanges,
        shouldStartLocked,
        pauseActionType,
      }
    )(reducer, initialState);

    instances[id] = {
      name: name || id,
      id,
      store,
      filters: (filters || actionsBlacklist || actionsWhitelist) && {
        whitelist: actionsWhitelist,
        blacklist: actionsBlacklist,
        ...filters,
      },
      actionCreators: actionCreators && (() => getActionsArray(actionCreators)),
      stateSanitizer,
      actionSanitizer,
    };

    start(instances[id]);
    store.subscribe(() => {
      handleChange(store.getState(), store.liftedStore.getState(), maxAge, instances[id]);
    });
    return store;
  };
}

const preEnhancer = instanceId => next =>
  (reducer, initialState, enhancer) => {
    const store = next(reducer, initialState, enhancer);

    if (instances[instanceId]) {
      instances[instanceId].store = store;
    }
    return {
      ...store,
      dispatch: (action) => (
        locked ? action : store.dispatch(action)
      ),
    };
  };

devToolsEnhancer.updateStore = (newStore, instanceId) => {
  console.warn(
    '`reduxNativeDevTools.updateStore` is deprecated use `reduxNativeDevToolsCompose` instead:',
    'https://github.com/jhen0409/react-native-debugger#advanced-store-setup'
  );

  const keys = Object.keys(instances);
  if (!keys.length) return;

  if (keys.length > 1 && !instanceId) {
    console.warn(
      'You have multiple stores,',
      'please provide `instanceId` argument (`updateStore(store, instanceId)`)'
    );
  }
  if (instanceId) {
    const instance = instances[instanceId];
    if (!instance) return;
    instance.store = newStore;
  } else {
    instances[keys[0]].store = newStore;
  }
};

const compose = options => (...funcs) => (...args) => {
  const instanceId = generateId(options.instanceId);
  return [preEnhancer(instanceId), ...funcs].reduceRight(
    (composed, f) => f(composed), devToolsEnhancer({ ...options, instanceId })(...args)
  );
};

export function composeWithDevTools(...funcs) {
  if (funcs.length === 0) {
    return devToolsEnhancer();
  }
  if (funcs.length === 1 && typeof funcs[0] === 'object') {
    return compose(funcs[0]);
  }
  return compose({})(...funcs);
}
