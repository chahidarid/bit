/** @flow */
import path from 'path';
import fs from 'fs-extra';
import R from 'ramda';
import format from 'string-format';
import assignwith from 'lodash.assignwith';
import groupby from 'lodash.groupby';
import unionBy from 'lodash.unionby';
import ignore from 'ignore';
import arrayDiff from 'array-difference';
import { Analytics } from '../../../analytics/analytics';
import {
  glob,
  isDir,
  calculateFileInfo,
  existsSync,
  pathNormalizeToLinux,
  getMissingTestFiles,
  retrieveIgnoreList,
  pathJoinLinux,
  isAutoGeneratedFile
} from '../../../utils';
import { Consumer } from '../../../consumer';
import BitMap from '../../../consumer/bit-map';
import { BitId } from '../../../bit-id';
import type { BitIdStr } from '../../../bit-id/bit-id';
import { COMPONENT_ORIGINS, DEFAULT_DIST_DIRNAME, VERSION_DELIMITER } from '../../../constants';
import logger from '../../../logger/logger';
import {
  PathsNotExist,
  MissingComponentIdForImportedComponent,
  IncorrectIdForImportedComponent,
  NoFiles,
  DuplicateIds,
  EmptyDirectory,
  TestIsDirectory,
  ExcludedMainFile,
  MainFileIsDir
} from './exceptions';
import type { ComponentMapFile, ComponentOrigin } from '../../bit-map/component-map';
import type { PathLinux, PathOsBased } from '../../../utils/path';
import ComponentMap from '../../bit-map/component-map';
import GeneralError from '../../../error/general-error';
import VersionShouldBeRemoved from './exceptions/version-should-be-removed';
import { isSupportedExtension } from '../../../links/link-content';

export type AddResult = { id: string, files: ComponentMapFile[] };
export type AddActionResults = { addedComponents: AddResult[], warnings: Object };
export type PathOrDSL = PathOsBased | string; // can be a path or a DSL, e.g: tests/{PARENT}/{FILE_NAME}
type PathsStats = { [PathOsBased]: { isDir: boolean } };
type AddedComponent = {
  componentId: BitId,
  files: ComponentMapFile[],
  mainFile?: ?PathOsBased,
  trackDir?: PathOsBased // set only when one directory is added by author
};
const REGEX_DSL_PATTERN = /{([^}]+)}/g;

/**
 * validatePaths - validate if paths entered by user exist and if not throw an error
 *
 * @param {string[]} fileArray - array of paths
 * @returns {PathsStats} componentPathsStats
 */
function validatePaths(fileArray: string[]): PathsStats {
  const componentPathsStats = {};
  fileArray.forEach((componentPath) => {
    if (!existsSync(componentPath)) {
      throw new PathsNotExist([componentPath]);
    }
    componentPathsStats[componentPath] = {
      isDir: isDir(componentPath)
    };
  });
  return componentPathsStats;
}

/**
 * validate that no two files where added with the same id in the same bit add command
 */
const validateNoDuplicateIds = (addComponents: Object[]) => {
  const duplicateIds = {};
  const newGroupedComponents = groupby(addComponents, 'componentId');
  Object.keys(newGroupedComponents).forEach((key) => {
    if (newGroupedComponents[key].length > 1) duplicateIds[key] = newGroupedComponents[key];
  });
  if (!R.isEmpty(duplicateIds) && !R.isNil(duplicateIds)) throw new DuplicateIds(duplicateIds);
};

export type AddProps = {
  componentPaths: PathOsBased[],
  id?: string,
  main?: PathOsBased,
  namespace?: string,
  tests?: PathOrDSL[],
  exclude?: PathOrDSL[],
  override: boolean,
  trackDirFeature?: boolean,
  origin?: ComponentOrigin,
  configuredConsumer: boolean
};

export default class AddComponents {
  consumer: Consumer;
  bitMap: BitMap;
  componentPaths: PathOsBased[];
  id: ?string; // id entered by the user
  main: ?PathOsBased;
  namespace: ?string;
  tests: PathOrDSL[];
  exclude: PathOrDSL[];
  override: boolean; // (default = false) replace the files array or only add files.
  trackDirFeature: ?boolean;
  warnings: Object;
  ignoreList: string[];
  gitIgnore: any;
  origin: ComponentOrigin;
  configuredConsumer: boolean;
  constructor(consumer: Consumer, addProps: AddProps) {
    this.configuredConsumer = addProps.configuredConsumer;
    const consumerPath = consumer.getPath();
    this.consumer = consumer;
    this.bitMap = consumer.bitMap;
    this.componentPaths =
      this.configuredConsumer === true
        ? addProps.componentPaths.map(file => path.join(consumerPath, file))
        : addProps.componentPaths;
    this.id = addProps.id;
    this.main = addProps.main;
    this.namespace = addProps.namespace;
    this.initializeTests(addProps);
    this.initializeExcluded(addProps);
    this.override = addProps.override;
    this.trackDirFeature = addProps.trackDirFeature;
    this.origin = addProps.origin || COMPONENT_ORIGINS.AUTHORED;
    this.warnings = {};
  }

  initializeExcluded(addProps: AddProps) {
    if (addProps.exclude && addProps.exclude.length) {
      if (addProps.configuredConsumer === true) {
        this.exclude = addProps.exclude.map(file => path.join(this.consumer.getPath(), file));
      } else {
        this.exclude = addProps.exclude;
      }
    } else {
      this.exclude = [];
    }
  }

  initializeTests(addProps: AddProps) {
    if (addProps.tests && addProps.tests.length > 0) {
      if (addProps.configuredConsumer) {
        this.tests = addProps.tests.map(file => path.join(this.consumer.getPath(), file));
      } else {
        this.tests = addProps.tests;
      }
    } else {
      this.tests = [];
    }
  }

  /**
   * @param {string[]} files - array of file-paths from which it should search for the dsl patterns.
   * @param {*} filesWithPotentialDsl - array of file-path which may have DSL patterns
   *
   * @returns array of file-paths from 'files' parameter that match the patterns from 'filesWithPotentialDsl' parameter
   */
  async getFilesAccordingToDsl(files: string[], filesWithPotentialDsl: PathOrDSL[]): Promise<PathLinux[]> {
    const filesListAllMatches = filesWithPotentialDsl.map(async (dsl) => {
      const filesListMatch = files.map(async (file) => {
        const fileInfo = calculateFileInfo(file);
        const generatedFile = format(dsl, fileInfo);
        const matches = await glob(generatedFile);
        const matchesAfterGitIgnore = this.gitIgnore.filter(matches);
        return matchesAfterGitIgnore.filter(match => fs.existsSync(match));
      });
      return Promise.all(filesListMatch);
    });

    const filesListFlatten = R.flatten(await Promise.all(filesListAllMatches));
    const filesListUnique = R.uniq(filesListFlatten);
    return filesListUnique.map((file) => {
      const relativeToConsumer = this.consumer.getPathRelativeToConsumer(file);
      return pathNormalizeToLinux(relativeToConsumer);
    });
  }

  addToBitMap({ componentId, files, mainFile, trackDir }: AddedComponent): AddResult {
    const getComponentMap = (): ComponentMap => {
      if (this.trackDirFeature) {
        return this.bitMap.addFilesToComponent({ componentId, files });
      }
      return this.bitMap.addComponent({
        componentId,
        files,
        mainFile,
        trackDir,
        origin: COMPONENT_ORIGINS.AUTHORED,
        override: this.override
      });
    };
    const componentMap = getComponentMap();
    return { id: componentId.toString(), files: componentMap.files };
  }

  /**
   * unsupported files, such as, binary files, don't have link-file. instead, they have a symlink
   * inside the component dir, pointing to the dependency.
   * this methods check whether a file is auto generated for the unsupported files.
   */
  async _isGeneratedForUnsupportedFiles(
    fileRelativePath: PathLinux,
    componentId: BitId,
    componentMap: ComponentMap
  ): Promise<boolean> {
    if (isSupportedExtension(fileRelativePath)) return false;
    const componentFromModel = await this.consumer.loadComponentFromModel(componentId);
    const dependencies = componentFromModel.getAllDependenciesCloned();
    const sourcePaths = dependencies.getSourcesPaths();
    const sourcePathsRelativeToConsumer = sourcePaths.map(sourcePath =>
      pathJoinLinux(componentMap.rootDir, sourcePath)
    );
    return sourcePathsRelativeToConsumer.includes(fileRelativePath);
  }

  /**
   * Add or update existing (imported and new) component according to bitmap
   * there are 3 options:
   * 1. a user is adding a new component. there is no record for this component in bit.map
   * 2. a user is updating an existing component. there is a record for this component in bit.map
   * 3. some or all the files of this component were previously added as another component-id.
   */
  async addOrUpdateComponentInBitMap(component: AddedComponent): Promise<?AddResult> {
    const consumerPath = this.consumer.getPath();
    const parsedBitId = component.componentId;
    const files: ComponentMapFile[] = component.files;
    const foundComponentFromBitMap = this.bitMap.getComponentIfExist(component.componentId, {
      ignoreScopeAndVersion: true
    });
    const componentFilesP = files.map(async (file: ComponentMapFile) => {
      // $FlowFixMe null is removed later on
      const filePath = path.join(consumerPath, file.relativePath);
      if (isAutoGeneratedFile(filePath)) {
        return null;
      }
      const caseSensitive = false;
      const existingIdOfFile = this.bitMap.getComponentIdByPath(file.relativePath, caseSensitive);
      const idOfFileIsDifferent = existingIdOfFile && !existingIdOfFile.isEqual(parsedBitId);
      const existingComponentOfFile = existingIdOfFile ? this.bitMap.getComponent(existingIdOfFile) : undefined;
      const isImported =
        (foundComponentFromBitMap && foundComponentFromBitMap.origin === COMPONENT_ORIGINS.IMPORTED) ||
        (existingComponentOfFile && existingComponentOfFile.origin === COMPONENT_ORIGINS.IMPORTED);
      if (isImported) {
        // throw error in case user didn't add id to imported component or the id is incorrect
        if (!this.id) throw new MissingComponentIdForImportedComponent(parsedBitId.toStringWithoutVersion());
        if (idOfFileIsDifferent) {
          const existingIdWithoutVersion = existingIdOfFile.toStringWithoutVersion();
          // $FlowFixMe $this.id is not null at this point
          throw new IncorrectIdForImportedComponent(existingIdWithoutVersion, this.id, file.relativePath);
        }
        const isGeneratedForUnsupportedFiles = await this._isGeneratedForUnsupportedFiles(
          file.relativePath,
          component.componentId,
          foundComponentFromBitMap
        );
        if (isGeneratedForUnsupportedFiles) return null;
        delete component.trackDir;
      } else if (idOfFileIsDifferent) {
        // not imported component file but exists in bitmap
        if (this.warnings[existingIdOfFile]) this.warnings[existingIdOfFile].push(file.relativePath);
        else this.warnings[existingIdOfFile] = [file.relativePath];
        // $FlowFixMe null is removed later on
        return null;
      }
      return file;
    });
    const componentFiles = (await Promise.all(componentFilesP)).filter(file => file);
    if (!componentFiles.length) return null;
    // $FlowFixMe it can't be null due to the filter function
    component.files = componentFiles;
    return this.addToBitMap(component);
  }

  // remove excluded files from file list
  async removeExcludedFiles(componentsWithFiles: AddedComponent[]) {
    const files = R.flatten(componentsWithFiles.map(x => x.files.map(i => i.relativePath)));
    const resolvedExcludedFiles = await this.getFilesAccordingToDsl(files, this.exclude);
    componentsWithFiles.forEach((componentWithFiles: AddedComponent) => {
      const mainFile = componentWithFiles.mainFile ? pathNormalizeToLinux(componentWithFiles.mainFile) : undefined;
      if (resolvedExcludedFiles.includes(mainFile)) {
        componentWithFiles.files = [];
      } else {
        // if mainFile is excluded, exclude all files
        componentWithFiles.files = componentWithFiles.files.filter(
          key => !resolvedExcludedFiles.includes(key.relativePath)
        );
      }
    });
  }

  /**
   * if the id is already saved in bitmap file, it might have more data (such as scope, version)
   * use that id instead.
   */
  _getIdAccordingToExistingComponent(currentId: BitIdStr): BitId {
    const existingComponentId = this.bitMap.getExistingBitId(currentId, false);
    const componentExists = Boolean(existingComponentId);
    if (componentExists && this.bitMap.getComponent(existingComponentId).origin === COMPONENT_ORIGINS.NESTED) {
      throw new GeneralError(`One of your dependencies (${existingComponentId}) has already the same namespace and name.
    If you're trying to add a new component, please choose a new namespace or name.
    If you're trying to update a dependency component, please re-import it individually`);
    }
    if (currentId.includes(VERSION_DELIMITER)) {
      if (
        !existingComponentId || // this id is new, it shouldn't have a version
        !existingComponentId.hasVersion() || // this component is new, it shouldn't have a version
        // user shouldn't add files to a an existing component with different version
        // $FlowFixMe this function gets called only when this.id is set
        existingComponentId.version !== BitId.getVersionOnlyFromString(this.id)
      ) {
        // $FlowFixMe this.id is defined here
        throw new VersionShouldBeRemoved(this.id);
      }
    }
    return existingComponentId || BitId.parse(currentId, false);
  }

  /**
   * used for updating main file if exists or doesn't exists
   */
  _addMainFileToFiles(files: ComponentMapFile[]): ?PathOsBased {
    let mainFile = this.main;
    if (mainFile && mainFile.match(REGEX_DSL_PATTERN)) {
      // it's a DSL
      files.forEach((file) => {
        const fileInfo = calculateFileInfo(file.relativePath);
        const generatedFile = format(mainFile, fileInfo);
        const foundFile = R.find(R.propEq('relativePath', pathNormalizeToLinux(generatedFile)))(files);
        if (foundFile) {
          mainFile = foundFile.relativePath;
        }
        if (fs.existsSync(generatedFile) && !foundFile) {
          const shouldIgnore = this.gitIgnore.ignores(generatedFile);
          if (shouldIgnore) {
            // check if file is in exclude list
            throw new ExcludedMainFile(generatedFile);
          }
          files.push({
            relativePath: pathNormalizeToLinux(generatedFile),
            test: false,
            name: path.basename(generatedFile)
          });
          mainFile = generatedFile;
        }
      });
    }
    if (!mainFile) return undefined;
    const mainFileRelativeToConsumer = this.consumer.getPathRelativeToConsumer(mainFile);
    const mainPath = this.consumer.toAbsolutePath(mainFileRelativeToConsumer);
    if (fs.existsSync(mainPath)) {
      const shouldIgnore = this.gitIgnore.ignores(mainFileRelativeToConsumer);
      if (shouldIgnore) throw new ExcludedMainFile(mainFileRelativeToConsumer);
      if (isDir(mainPath)) {
        throw new MainFileIsDir(mainPath);
      }
      const foundFile = R.find(R.propEq('relativePath', pathNormalizeToLinux(mainFileRelativeToConsumer)))(files);
      if (!foundFile) {
        files.push({
          relativePath: pathNormalizeToLinux(mainFileRelativeToConsumer),
          test: false,
          name: path.basename(mainFileRelativeToConsumer)
        });
      }
      return mainFileRelativeToConsumer;
    }
    return mainFile;
  }

  async _mergeTestFilesWithFiles(files: ComponentMapFile[]): Promise<ComponentMapFile[]> {
    const testFiles = !R.isEmpty(this.tests)
      ? await this.getFilesAccordingToDsl(files.map(file => file.relativePath), this.tests)
      : [];

    const resolvedTestFiles = testFiles.map((testFile) => {
      if (isDir(path.join(this.consumer.getPath(), testFile))) throw new TestIsDirectory(testFile);
      return {
        relativePath: testFile,
        test: true,
        name: path.basename(testFile)
      };
    });

    return unionBy(resolvedTestFiles, files, 'relativePath');
  }

  /**
   * given the component paths, prepare the id, mainFile and files to be added later on to bitmap
   * the id of the component is either entered by the user or, if not entered, concluded by the path.
   * e.g. bar/foo.js, the id would be bar/foo.
   * in case bitmap has already the same id, the complete id is taken from bitmap (see _getIdAccordingToExistingComponent)
   */
  async addOneComponent(componentPathsStats: PathsStats): Promise<AddedComponent> {
    let finalBitId: BitId; // final id to use for bitmap file
    if (this.id) {
      finalBitId = this._getIdAccordingToExistingComponent(this.id);
    }

    const componentsWithFilesP = Object.keys(componentPathsStats).map(async (componentPath) => {
      if (componentPathsStats[componentPath].isDir) {
        const relativeComponentPath = this.consumer.getPathRelativeToConsumer(componentPath);

        const matches = await glob(path.join(relativeComponentPath, '**'), {
          cwd: this.consumer.getPath(),
          nodir: true
        });

        const filteredMatches = this.gitIgnore.filter(matches);

        if (!filteredMatches.length) throw new EmptyDirectory();

        let filteredMatchedFiles = filteredMatches.map((match: PathOsBased) => {
          return { relativePath: pathNormalizeToLinux(match), test: false, name: path.basename(match) };
        });

        // merge test files with files
        filteredMatchedFiles = await this._mergeTestFilesWithFiles(filteredMatchedFiles);
        const resolvedMainFile = this._addMainFileToFiles(filteredMatchedFiles);

        if (!finalBitId) {
          const absoluteComponentPath = path.resolve(componentPath);
          const splitPath = absoluteComponentPath.split(path.sep);
          const lastDir = splitPath[splitPath.length - 1];
          const nameSpaceOrDir = this.namespace || splitPath[splitPath.length - 2];
          const idFromPath = BitId.getValidBitId(nameSpaceOrDir, lastDir);
          finalBitId = this._getIdAccordingToExistingComponent(idFromPath.toString());
        }

        const trackDir =
          Object.keys(componentPathsStats).length === 1 &&
          !this.exclude.length &&
          this.origin === COMPONENT_ORIGINS.AUTHORED
            ? relativeComponentPath
            : undefined;

        return { componentId: finalBitId, files: filteredMatchedFiles, mainFile: resolvedMainFile, trackDir };
      }
      // is file
      const absolutePath = path.resolve(componentPath);
      const pathParsed = path.parse(absolutePath);
      const relativeFilePath = this.consumer.getPathRelativeToConsumer(componentPath);
      if (!finalBitId) {
        let dirName = pathParsed.dir;
        if (!dirName) {
          dirName = path.dirname(absolutePath);
        }
        const nameSpaceOrLastDir = this.namespace || R.last(dirName.split(path.sep));
        const idFromPath = BitId.getValidBitId(nameSpaceOrLastDir, pathParsed.name);
        finalBitId = this._getIdAccordingToExistingComponent(idFromPath.toString());
      }

      let files = [
        { relativePath: pathNormalizeToLinux(relativeFilePath), test: false, name: path.basename(relativeFilePath) }
      ];

      files = await this._mergeTestFilesWithFiles(files);
      const resolvedMainFile = this._addMainFileToFiles(files);
      return { componentId: finalBitId, files, mainFile: resolvedMainFile };
    });

    let componentsWithFiles: AddedComponent[] = await Promise.all(componentsWithFilesP);

    // remove files that are excluded
    if (!R.isEmpty(this.exclude)) await this.removeExcludedFiles(componentsWithFiles);

    const componentId = finalBitId;
    componentsWithFiles = componentsWithFiles.filter(componentWithFiles => componentWithFiles.files.length);

    // $FlowFixMe
    if (componentsWithFiles.length === 0) return { componentId, files: [] };
    if (componentsWithFiles.length === 1) return componentsWithFiles[0];

    const files = componentsWithFiles.reduce((a, b) => {
      return a.concat(b.files);
    }, []);
    const groupedComponents = groupby(files, 'relativePath');
    const uniqComponents = Object.keys(groupedComponents).map(key =>
      assignwith({}, ...groupedComponents[key], (val1, val2) => val1 || val2)
    );
    // $FlowFixMe
    return {
      componentId,
      files: uniqComponents,
      mainFile: R.head(componentsWithFiles).mainFile,
      trackDir: R.head(componentsWithFiles).trackDir
    };
  }

  getIgnoreList(): string[] {
    const consumerPath = this.consumer.getPath();
    let ignoreList = retrieveIgnoreList(consumerPath);
    const importedComponents = this.bitMap.getAllComponents(COMPONENT_ORIGINS.IMPORTED);
    const distDirsOfImportedComponents = Object.keys(importedComponents).map(key =>
      pathJoinLinux(importedComponents[key].rootDir, DEFAULT_DIST_DIRNAME, '**')
    );
    const configsToIgnore = this.bitMap.getConfigDirsAndFilesToIgnore(this.consumer.getPath());
    const configDirs = configsToIgnore.dirs.map(dir => pathJoinLinux(dir, '**'));
    ignoreList = ignoreList.concat(distDirsOfImportedComponents);
    ignoreList = ignoreList.concat(configsToIgnore.files);
    ignoreList = ignoreList.concat(configDirs);
    return ignoreList;
  }

  async add(): Promise<AddActionResults> {
    this.ignoreList = this.getIgnoreList();
    this.ignoreList = this.ignoreList.map((ignorePattern) => {
      if (ignorePattern.startsWith('**/')) {
        return ignorePattern;
      } else if (this.configuredConsumer === true) {
        return path.join('**/', ignorePattern);
      }
      return ignorePattern;
    });

    this.gitIgnore = ignore().add(this.ignoreList); // add ignore list

    // check unknown test files
    const missingFiles = getMissingTestFiles(this.tests);
    if (!R.isEmpty(missingFiles)) {
      throw new PathsNotExist(missingFiles);
    }
    let componentPathsStats = {};

    const resolvedComponentPathsWithoutGitIgnore = R.flatten(
      await Promise.all(this.componentPaths.map(componentPath => glob(componentPath)))
    );

    /** add excluded list to gitignore to remove excluded files from list */
    const resolvedExcludedFiles = await this.getFilesAccordingToDsl(
      resolvedComponentPathsWithoutGitIgnore,
      this.exclude
    );
    this.ignoreList = [...this.ignoreList, ...resolvedExcludedFiles];
    this.gitIgnore = ignore().add(this.ignoreList); // add ignore list

    const resolvedComponentPathsWithGitIgnore = this.gitIgnore.filter(resolvedComponentPathsWithoutGitIgnore);
    // Run diff on both arrays to see what was filtered out because of the gitignore file
    const diff = arrayDiff(resolvedComponentPathsWithGitIgnore, resolvedComponentPathsWithoutGitIgnore);

    if (!R.isEmpty(this.tests) && this.id && R.isEmpty(resolvedComponentPathsWithoutGitIgnore)) {
      const resolvedTestFiles = R.flatten(await Promise.all(this.tests.map(componentPath => glob(componentPath))));
      componentPathsStats = validatePaths(resolvedTestFiles);
    } else {
      if (R.isEmpty(resolvedComponentPathsWithoutGitIgnore)) {
        throw new PathsNotExist(this.componentPaths);
      }
      if (!R.isEmpty(resolvedComponentPathsWithGitIgnore)) {
        componentPathsStats = validatePaths(resolvedComponentPathsWithGitIgnore);
      } else {
        throw new NoFiles(diff);
      }
    }
    // if a user entered multiple paths and entered an id, he wants all these paths to be one component
    // conversely, if a user entered multiple paths without id, he wants each dir as an individual component
    const isMultipleComponents = Object.keys(componentPathsStats).length > 1 && !this.id;
    const addedComponents: AddResult[] = [];
    if (isMultipleComponents) {
      logger.debug('bit add - multiple components');
      const testToRemove = !R.isEmpty(this.tests)
        ? await this.getFilesAccordingToDsl(Object.keys(componentPathsStats), this.tests)
        : [];
      testToRemove.forEach(test => delete componentPathsStats[path.normalize(test)]);
      const addedP = Object.keys(componentPathsStats).map((onePath) => {
        const oneComponentPathStat = { [onePath]: componentPathsStats[onePath] };
        return this.addOneComponent(oneComponentPathStat);
      });

      const added = await Promise.all(addedP);
      validateNoDuplicateIds(added);
      await Promise.all(
        added.map(async (component) => {
          if (!R.isEmpty(component.files)) {
            const addedComponent = await this.addOrUpdateComponentInBitMap(component);
            if (addedComponent) addedComponents.push(addedComponent);
          }
        })
      );
    } else {
      logger.debug('bit add - one component');
      // when a user enters more than one directory, he would like to keep the directories names
      // so then when a component is imported, it will write the files into the original directories
      const addedOne = await this.addOneComponent(componentPathsStats);
      if (!R.isEmpty(addedOne.files)) {
        const addedResult = await this.addOrUpdateComponentInBitMap(addedOne);
        if (addedResult) addedComponents.push(addedResult);
      }
    }
    Analytics.setExtraData('num_components', addedComponents.length);
    return { addedComponents, warnings: this.warnings };
  }
}
