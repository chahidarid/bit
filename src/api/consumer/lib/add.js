/** @flow */
import path from 'path';
import type { PathOsBased } from '../../../utils/path';
import AddComponents from '../../../consumer/component-ops/add-components';
import type {
  AddProps,
  AddContext,
  AddActionResults,
  PathOrDSL
} from '../../../consumer/component-ops/add-components/add-components';
import { loadConsumer, Consumer } from '../../../consumer';

export async function addOne(addProps: AddProps): Promise<AddActionResults> {
  const consumer: Consumer = await loadConsumer();
  const overridenConsumer = false;
  const addContext: AddContext = { consumer, overridenConsumer };
  const addComponents = new AddComponents(addContext, addProps);
  const addResults = await addComponents.add();
  await consumer.onDestroy();
  return addResults;
}

export async function addMany(
  components: AddProps[],
  consumerPath: string = process.cwd()
): Promise<AddActionResults[]> {
  // we are checking whether the consumer is the default consumer which is process.cwd() or it is overriden , and we are working on another directory which is not the process.cwd()
  const overridenConsumer = consumerPath !== process.cwd();
  const consumer: Consumer = await loadConsumer(consumerPath);
  const addContext: AddContext = { consumer, overridenConsumer };
  const addComponentsArr = [];
  components.forEach((component) => {
    const normalizedPaths: PathOsBased[] = component.componentPaths.map((p) => {
      return path.normalize(p);
    });
    component.componentPaths = normalizedPaths;
    const normalizedTests: PathOrDSL[] = component.tests
      ? component.tests.map(testFile => path.normalize(testFile.trim()))
      : [];
    component.tests = normalizedTests;
    component.exclude = component.exclude
      ? component.exclude.map(excludeFile => path.normalize(excludeFile.trim()))
      : [];
    const addComponents = new AddComponents(addContext, component);
    addComponentsArr.push(addComponents);
  });
  const addResults = [];
  await Promise.all(
    addComponentsArr.map(async function (addComponents) {
      const addResultsSingle = await addComponents.add();
      addResults.push(addResultsSingle);
    })
  );
  await consumer.onDestroy();
  return addResults;
}
